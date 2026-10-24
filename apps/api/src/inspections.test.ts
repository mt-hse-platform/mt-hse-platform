import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import { batchingPlantTemplate } from '../../../packages/engines/src/template/fixtures.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier } from './ports.ts';

const ORG_A = '00000000-0000-0000-0000-00000000aaaa';
const ORG_B = '00000000-0000-0000-0000-00000000bbbb';
const SITE_A = '00000000-0000-0000-0000-0000000051a1';
const SITE_X = '00000000-0000-0000-0000-0000000051b2';

const USERS: Record<string, { id: string; org: string; role: RoleKey; sites: string[] }> = {
  manager:    { id: '00000000-0000-0000-0000-000000000001', org: ORG_A, role: 'hse_manager', sites: [] },
  supervisor: { id: '00000000-0000-0000-0000-000000000002', org: ORG_A, role: 'supervisor', sites: [SITE_A] },
  employee:   { id: '00000000-0000-0000-0000-000000000003', org: ORG_A, role: 'employee', sites: [SITE_A] },
  viewer:     { id: '00000000-0000-0000-0000-000000000005', org: ORG_A, role: 'viewer', sites: [SITE_A] },
  inspector:  { id: '00000000-0000-0000-0000-000000000006', org: ORG_A, role: 'inspector', sites: [SITE_A] },
  inspector2: { id: '00000000-0000-0000-0000-000000000008', org: ORG_A, role: 'inspector', sites: [SITE_A] },
  managerB:   { id: '00000000-0000-0000-0000-000000000007', org: ORG_B, role: 'hse_manager', sites: [] },
};
const verifier: TokenVerifier = { async verify(t) { if (t.startsWith('tok-') && USERS[t.slice(4)]) return { uid: t.slice(4) }; throw new Error('bad'); } };
const store: IdentityStore = {
  async resolveByFirebaseUid(uid) {
    const u = USERS[uid];
    return u ? [{ userId: u.id, orgId: u.org, membershipId: `m-${uid}`, roleId: uid, userActive: true, membershipActive: true } as MembershipRecord] : [];
  },
  async loadUser(m) { return { fullName: m.userId, email: `${m.userId}@x.com`, locale: 'ar' }; },
  async loadGrants(m) { return DEFAULT_ROLE_GRANTS[USERS[m.roleId]!.role]; },
  async loadSiteIds(m) { return USERS[m.roleId]!.sites; },
};

type R = { status: number; body: any };
type Client = (who: string | null, method: string, path: string, body?: unknown) => Promise<R>;

async function run(fn: (c: Client, repo: MemoryWorkRepo) => Promise<void>) {
  const repo = new MemoryWorkRepo();
  for (const u of Object.values(USERS)) repo.addMember(u.org, u.id);
  const server = createApi({
    verifier, store, work: repo, logger: { error: () => undefined },
    clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c: Client = async (who, method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  try { await fn(c, repo); } finally { await new Promise((r) => server.close(r)); }
}

/** A published template (v1 = the batching-plant example) ready to be inspected. */
async function publishedTemplate(c: Client, content = batchingPlantTemplate()) {
  const t = (await c('manager', 'POST', '/templates', { name: { en: 'Batching plant' }, content })).body;
  const p = (await c('manager', 'POST', `/templates/${t.template.id}/publish`, { version: t.draftVersion })).body;
  return { templateId: t.template.id as string, versionId: p.version.id as string };
}
const start = async (c: Client, who: string, templateId: string, extra: Record<string, unknown> = {}) =>
  (await c(who, 'POST', '/inspections', { templateId, siteId: SITE_A, ...extra })).body.inspection as { id: string; version: number; templateVersionId: string };
const answer = (c: Client, who: string, id: string, qid: string, value: unknown, baseVersion = 0) =>
  c(who, 'PUT', `/inspections/${id}/responses/${qid}`, { value, baseVersion });

const GOOD = { q_helmet: 'no', q_vest: 'yes', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 };
async function fillAll(c: Client, who: string, id: string, answers: Record<string, unknown>) {
  for (const [q, v] of Object.entries(answers)) assert.equal((await answer(c, who, id, q, v)).status, 200, q);
}

test('requires authentication', async () => {
  await run(async (c) => {
    assert.equal((await c(null, 'GET', '/inspections')).status, 401);
    assert.equal((await c(null, 'POST', '/inspections', {})).status, 401);
  });
});

test('start: pins the published version; who can; unpublished and unknown templates', async () => {
  await run(async (c) => {
    const { templateId, versionId } = await publishedTemplate(c);
    const r = await c('inspector', 'POST', '/inspections', { templateId, siteId: SITE_A, title: 'Morning round' });
    assert.equal(r.status, 201);
    assert.equal(r.body.inspection.status, 'in_progress');
    assert.equal(r.body.inspection.templateVersionId, versionId);
    assert.equal(r.body.inspection.startedBy, USERS.inspector!.id);
    assert.equal(r.body.inspection.title, 'Morning round');

    assert.equal((await c('employee', 'POST', '/inspections', { templateId })).status, 403);
    assert.equal((await c('viewer', 'POST', '/inspections', { templateId })).status, 403);
    assert.equal((await c('inspector', 'POST', '/inspections', {})).body.errors.templateId[0].code, 'required');
    assert.equal((await c('inspector', 'POST', '/inspections', { templateId: '00000000-0000-0000-0000-00000000dead' })).status, 404);

    const draftOnly = (await c('manager', 'POST', '/templates', { name: { en: 'Draft only' } })).body.template.id;
    assert.equal((await c('inspector', 'POST', '/inspections', { templateId: draftOnly })).body.code, 'no_published_version');
    assert.equal((await c('managerB', 'POST', '/inspections', { templateId })).status, 404, 'template of another organization');
  });
});

test('an inspection keeps the template version it started with, even after a new version is published', async () => {
  await run(async (c) => {
    const { templateId, versionId } = await publishedTemplate(c);
    const old = await start(c, 'inspector', templateId);
    await fillAll(c, 'inspector', old.id, { q_helmet: 'yes' });

    // manager publishes version 2 with a much smaller template
    const d = (await c('manager', 'POST', `/templates/${templateId}/drafts`)).body.version;
    const smaller = batchingPlantTemplate(); smaller.pages = smaller.pages.slice(0, 1);
    const saved = await c('manager', 'PUT', `/templates/${templateId}/draft`, { version: d.version, content: smaller });
    assert.equal((await c('manager', 'POST', `/templates/${templateId}/publish`, { version: saved.body.version.version })).status, 200);

    const again = (await c('inspector', 'GET', `/inspections/${old.id}`)).body;
    assert.equal(again.inspection.templateVersionId, versionId);
    assert.ok('q_fire_ext' in again.evaluation.state.required, 'still evaluated against version 1 (has the equipment page)');
    const fresh = await start(c, 'inspector', templateId);
    assert.notEqual(fresh.templateVersionId, versionId, 'new inspections use version 2');
  });
});

test('autosave: create, update, stale write conflict, clearing, validation, computed and unknown questions', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    const i = await start(c, 'inspector', templateId);

    const first = await answer(c, 'inspector', i.id, 'q_helmet', 'yes', 0);
    assert.equal(first.status, 200);
    assert.equal(first.body.response.version, 1);
    const second = await answer(c, 'inspector', i.id, 'q_helmet', 'no', 1);
    assert.equal(second.body.response.version, 2);

    const stale = await answer(c, 'inspector', i.id, 'q_helmet', 'na', 1);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.errors.current.value, 'no', 'the client receives the server value to resolve the conflict');
    assert.equal(stale.body.errors.current.version, 2);
    assert.equal((await answer(c, 'inspector', i.id, 'q_helmet', 'na', 0)).status, 409, 'insert over an existing answer');
    assert.equal((await answer(c, 'inspector', i.id, 'q_vest', 'yes', 5)).status, 409, 'update of a missing answer');

    assert.equal((await answer(c, 'inspector', i.id, 'q_helmet', null, 2)).body.response.value, null, 'clearing');
    assert.equal((await answer(c, 'inspector', i.id, 'q_helmet', 'maybe', 3)).body.errors.value[0].code, 'invalid_option');
    assert.equal((await answer(c, 'inspector', i.id, 'q_pressure', 99, 0)).body.errors.value[0].code, 'max');
    assert.equal((await answer(c, 'inspector', i.id, 'q_total', 5, 0)).body.code, 'computed_field');
    assert.equal((await answer(c, 'inspector', i.id, 'nope', 'x', 0)).status, 404);
    assert.equal((await answer(c, 'inspector', i.id, 'bad id!', 'x', 0)).status, 404);
    assert.equal((await c('inspector', 'PUT', `/inspections/${i.id}/responses/q_helmet`, { value: 'yes' })).body.errors.baseVersion[0].code, 'required');
    assert.equal((await c('inspector', 'PUT', `/inspections/${i.id}/responses/q_helmet`, { baseVersion: 0 })).body.errors.value[0].code, 'required');
    assert.equal((await c('inspector', 'PUT', `/inspections/${i.id}/responses/q_helmet`, { value: 'yes', baseVersion: 3, by: 'x' })).body.errors.by[0].code, 'unknown_field');
  });
});

test('autosave permissions: only the owner (or org-wide editors); viewers read only; other organization sees nothing', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    const i = await start(c, 'inspector', templateId);
    assert.equal((await answer(c, 'inspector2', i.id, 'q_helmet', 'yes')).status, 404, 'another inspector cannot even see it');
    assert.equal((await answer(c, 'viewer', i.id, 'q_helmet', 'yes')).status, 403, 'viewer can read (site) but not edit');
    assert.equal((await answer(c, 'supervisor', i.id, 'q_helmet', 'yes')).status, 200, 'supervisor of the site can edit');
    assert.equal((await answer(c, 'manager', i.id, 'q_vest', 'yes')).status, 200);
    assert.equal((await answer(c, 'managerB', i.id, 'q_helmet', 'yes')).status, 404);
  });
});

test('GET shows live evaluation: visibility, scores, progress and missing required answers', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    const i = await start(c, 'inspector', templateId);
    const g0 = (await c('inspector', 'GET', `/inspections/${i.id}`)).body;
    assert.deepEqual(g0.progress, { answered: 0, total: 10, requiredMissing: 1 });
    assert.equal(g0.errors.q_helmet[0].code, 'required');

    await fillAll(c, 'inspector', i.id, { q_helmet: 'yes', q_vest: 'no', q_hours: 4, q_cost: 2, q_pressure: 9 });
    const g1 = (await c('inspector', 'GET', `/inspections/${i.id}`)).body;
    assert.equal(g1.evaluation.answers.q_total, 8, 'formula computed on the server');
    assert.equal(g1.evaluation.state.visible.p_emergency, true);
    assert.deepEqual(g1.progress, { answered: 5, total: 11, requiredMissing: 1 });
    assert.deepEqual(g1.evaluation.flags.map((f: any) => f.questionId).sort(), ['q_pressure', 'q_vest']);
    assert.equal(g1.responses.q_helmet.version, 1);
    assert.equal(g1.evaluation.scores.total.pct, 33.33);
  });
});

test('complete: refuses while required answers are missing, then scores, creates flags and freezes the inspection', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    const i = await start(c, 'inspector', templateId);
    await fillAll(c, 'inspector', i.id, { q_vest: 'yes', q_fire_ext: 'pass', q_condition: 'poor', q_rating: 5 });

    const early = await c('inspector', 'POST', `/inspections/${i.id}/complete`);
    assert.equal(early.status, 422);
    assert.equal(early.body.code, 'incomplete');
    assert.deepEqual(Object.keys(early.body.errors).sort(), ['q_helmet', 'q_notes'], 'required + conditionally required');

    await fillAll(c, 'inspector', i.id, { q_helmet: 'no', q_notes: 'Belt torn' });
    await answer(c, 'inspector', i.id, 'q_condition', 'good', 1);
    const done = await c('inspector', 'POST', `/inspections/${i.id}/complete`);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const insp = done.body.inspection;
    assert.equal(insp.status, 'completed');
    assert.equal(insp.completedAt, '2026-10-03T10:00:00.000Z');
    assert.equal(insp.scoreEarned, 405);
    assert.equal(insp.scorePossible, 505);
    assert.equal(insp.scorePct, 80.2);
    assert.equal(insp.passed, true);
    assert.equal(insp.flaggedRate, 20);
    assert.deepEqual(done.body.flags.map((f: any) => [f.questionId, f.severity, f.status]), [['q_helmet', 'high', 'open']]);
    assert.equal((await c('inspector', 'GET', `/inspections/${i.id}/flags`)).body.items.length, 1);

    // frozen
    assert.equal((await c('inspector', 'POST', `/inspections/${i.id}/complete`)).body.code, 'not_editable');
    assert.equal((await answer(c, 'inspector', i.id, 'q_vest', 'no', 1)).body.code, 'not_editable');
    assert.equal((await c('inspector', 'POST', `/inspections/${i.id}/cancel`)).body.code, 'not_editable');
    const tl = (await c('inspector', 'GET', `/inspections/${i.id}/timeline`)).body.items;
    assert.deepEqual(tl.map((e: any) => e.event), ['started', 'completed']);
    assert.equal(tl[1].newValue.flags, 1);
  });
});

test('cancel: only while in progress; afterwards nothing can be edited', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    const i = await start(c, 'inspector', templateId);
    assert.equal((await c('inspector2', 'POST', `/inspections/${i.id}/cancel`)).status, 404);
    assert.equal((await c('viewer', 'POST', `/inspections/${i.id}/cancel`)).status, 403);
    const r = await c('inspector', 'POST', `/inspections/${i.id}/cancel`);
    assert.equal(r.body.inspection.status, 'cancelled');
    assert.ok(r.body.inspection.cancelledAt);
    assert.equal((await answer(c, 'inspector', i.id, 'q_helmet', 'yes')).body.code, 'not_editable');
    assert.equal((await c('inspector', 'POST', `/inspections/${i.id}/cancel`)).body.code, 'not_editable');
  });
});

test('visibility of lists and records by role and organization', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    const mine = await start(c, 'inspector', templateId, { title: 'mine' });
    const theirs = await start(c, 'inspector2', templateId, { title: 'theirs' });
    const far = await start(c, 'manager', templateId, { title: 'far', siteId: SITE_X });

    const titles = async (who: string) => (await c(who, 'GET', '/inspections')).body.items.map((x: any) => x.title).sort();
    assert.deepEqual(await titles('inspector'), ['mine']);
    assert.deepEqual(await titles('supervisor'), ['mine', 'theirs'], 'site scope');
    assert.deepEqual(await titles('viewer'), ['mine', 'theirs']);
    assert.deepEqual(await titles('manager'), ['far', 'mine', 'theirs']);
    assert.deepEqual(await titles('managerB'), []);
    assert.equal((await c('employee', 'GET', '/inspections')).status, 403);

    assert.equal((await c('inspector', 'GET', `/inspections/${theirs.id}`)).status, 404);
    assert.equal((await c('supervisor', 'GET', `/inspections/${far.id}`)).status, 404);
    assert.equal((await c('managerB', 'GET', `/inspections/${mine.id}`)).status, 404);
    assert.equal((await c('manager', 'GET', '/inspections?status=weird')).status, 422);
    assert.equal((await c('manager', 'GET', '/inspections?status=completed')).body.items.length, 0);
  });
});

test('pagination and malformed ids', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    for (let n = 0; n < 5; n++) await start(c, 'manager', templateId, { title: `I${n}` });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: R = await c('manager', 'GET', `/inspections?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...r.body.items.map((x: any) => x.title));
      cursor = r.body.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, ['I4', 'I3', 'I2', 'I1', 'I0']);
    assert.equal((await c('manager', 'GET', '/inspections/not-a-uuid')).status, 404);
    assert.equal((await c('manager', 'DELETE', '/inspections/00000000-0000-0000-0000-000000000009')).status, 404);
  });
});

// ---------- one-tap Issue / Action from a flagged item ----------

async function completedWithFlags(c: Client) {
  const { templateId } = await publishedTemplate(c);
  const i = await start(c, 'inspector', templateId);
  await fillAll(c, 'inspector', i.id, { q_helmet: 'no', q_vest: 'no', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 });
  const done = await c('inspector', 'POST', `/inspections/${i.id}/complete`);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const flag = (q: string) => done.body.flags.find((f: any) => f.questionId === q).id as string;
  return { id: i.id, templateId, versionId: i.templateVersionId, helmet: flag('q_helmet'), vest: flag('q_vest') };
}

test('action from a flag is pre-filled from the inspection and the question; a flag links once per kind', async () => {
  await run(async (c) => {
    const f = await completedWithFlags(c);
    const r = await c('inspector', 'POST', `/inspections/${f.id}/flags/${f.helmet}/action`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const a = r.body.action;
    assert.equal(a.title, 'هل الجميع يرتدي الخوذة؟', 'question title in the user language');
    assert.equal(a.description, 'Helmet missing', 'falls back to the other language when the flag note has no Arabic text');
    assert.equal(a.siteId, SITE_A);
    assert.equal(a.inspectionId, f.id);
    assert.equal(a.templateId, f.templateId);
    assert.equal(a.templateVersionId, f.versionId);
    assert.equal(a.questionId, 'q_helmet');
    assert.equal(a.priority, 'high', 'taken from the flag severity');
    assert.equal(a.type, 'corrective');
    assert.equal(a.status, 'todo');
    assert.equal(a.ownerId, USERS.inspector!.id);
    assert.equal(r.body.flag.actionId, a.id);

    assert.equal((await c('inspector', 'POST', `/inspections/${f.id}/flags/${f.helmet}/action`)).body.code, 'already_linked');
    assert.equal((await c('inspector', 'GET', `/actions/${a.id}`)).status, 200);

    // the same flag can still produce an issue, independently
    const i2 = await c('inspector', 'POST', `/inspections/${f.id}/flags/${f.helmet}/issue`);
    assert.equal(i2.status, 201, JSON.stringify(i2.body));
    assert.equal(i2.body.issue.type, 'other');
    assert.equal(i2.body.issue.priority, 'high');
    assert.equal(i2.body.issue.reporterId, USERS.inspector!.id);
    assert.equal(i2.body.issue.questionId, 'q_helmet');
    assert.equal(i2.body.flag.issueId, i2.body.issue.id);
    assert.equal(i2.body.flag.actionId, a.id);
    assert.equal((await c('inspector', 'POST', `/inspections/${f.id}/flags/${f.helmet}/issue`)).body.code, 'already_linked');

    const flags = (await c('inspector', 'GET', `/inspections/${f.id}/flags`)).body.items;
    assert.deepEqual(flags.map((x: any) => [x.questionId, !!x.issueId, !!x.actionId]).sort(), [['q_helmet', true, true], ['q_vest', false, false]]);
    const tl = (await c('inspector', 'GET', `/inspections/${f.id}/timeline`)).body.items.map((e: any) => e.event);
    assert.deepEqual(tl, ['started', 'completed', 'action_created_from_flag', 'issue_created_from_flag']);
    assert.deepEqual((await c('inspector', 'GET', `/actions/${a.id}/timeline`)).body.items.map((e: any) => e.event), ['created']);
  });
});

test('flag to action: overrides, assignment rules and validation', async () => {
  await run(async (c) => {
    const f = await completedWithFlags(c);
    const body = { title: 'Provide vests', priority: 'low', assigneeId: USERS.employee!.id, dueDate: '2026-10-20', description: 'Order 10 vests' };

    assert.equal((await c('inspector', 'POST', `/inspections/${f.id}/flags/${f.vest}/action`, body)).status, 403, 'inspector cannot assign');
    const ok = await c('manager', 'POST', `/inspections/${f.id}/flags/${f.vest}/action`, body);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.action.title, 'Provide vests');
    assert.equal(ok.body.action.priority, 'low');
    assert.equal(ok.body.action.assigneeId, USERS.employee!.id);
    assert.equal(ok.body.action.dueDate, '2026-10-20');
    assert.equal(ok.body.action.ownerId, USERS.manager!.id, 'the creator, not the inspector');
    assert.equal((await c('employee', 'GET', `/actions/${ok.body.action.id}`)).status, 200, 'the assignee can see it');

    const flag2 = (await c('inspector', 'GET', `/inspections/${f.id}/flags`)).body.items;
    assert.equal(flag2.find((x: any) => x.questionId === 'q_vest').actionId, ok.body.action.id);

    const f2 = await completedWithFlags(c);
    assert.equal((await c('manager', 'POST', `/inspections/${f2.id}/flags/${f2.vest}/action`, { dueDate: '2026-10-01' })).body.errors.dueDate[0].code, 'date_before_min');
    assert.equal((await c('manager', 'POST', `/inspections/${f2.id}/flags/${f2.vest}/action`, { priority: 'urgent' })).body.errors.priority[0].code, 'invalid_option');
    assert.equal((await c('manager', 'POST', `/inspections/${f2.id}/flags/${f2.vest}/action`, { siteId: SITE_X })).body.errors.siteId[0].code, 'unknown_field');
    assert.equal((await c('manager', 'POST', `/inspections/${f2.id}/flags/${f2.vest}/action`, { assigneeId: '00000000-0000-0000-0000-00000000dead' })).body.errors.assigneeId[0].code, 'invalid_reference');
    const still = (await c('manager', 'GET', `/inspections/${f2.id}/flags`)).body.items;
    assert.ok(still.every((x: any) => !x.actionId && !x.issueId), 'failed attempts link nothing');
  });
});

test('flag linking is hidden from people who cannot see the inspection and refused to those who cannot create', async () => {
  await run(async (c) => {
    const f = await completedWithFlags(c);
    assert.equal((await c('viewer', 'POST', `/inspections/${f.id}/flags/${f.helmet}/action`)).status, 403, 'can read, cannot create');
    assert.equal((await c('inspector2', 'POST', `/inspections/${f.id}/flags/${f.helmet}/action`)).status, 404);
    assert.equal((await c('employee', 'POST', `/inspections/${f.id}/flags/${f.helmet}/issue`)).status, 404);
    assert.equal((await c('managerB', 'POST', `/inspections/${f.id}/flags/${f.helmet}/action`)).status, 404);
    assert.equal((await c('supervisor', 'POST', `/inspections/${f.id}/flags/${f.helmet}/issue`)).status, 201, 'supervisor of the site');

    const other = await completedWithFlags(c);
    assert.equal((await c('manager', 'POST', `/inspections/${f.id}/flags/${other.helmet}/action`)).status, 404, 'flag of another inspection');
    assert.equal((await c('manager', 'POST', `/inspections/${f.id}/flags/00000000-0000-0000-0000-00000000dead/action`)).status, 404);
    assert.equal((await c('manager', 'POST', `/inspections/${f.id}/flags/not-a-uuid/action`)).status, 404);
  });
});

// ---------- starting an inspection offline: the app chooses the id and the template version ----------

const NEW_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const post = (c: Client, who: string, body: Record<string, unknown>) => c(who, 'POST', '/inspections', body);
const mine = async (c: Client, who: string) => ((await c(who, 'GET', '/inspections?status=in_progress&limit=100')).body.items as { id: string }[]).map((i) => i.id);

test('offline start: the inspection is created with the id the app chose, and answers can be saved to it', async () => {
  await run(async (c) => {
    const { templateId, versionId } = await publishedTemplate(c);
    const r = await post(c, 'inspector', { id: NEW_ID, templateId, templateVersionId: versionId, siteId: SITE_A });
    assert.equal(r.status, 201);
    assert.equal(r.body.inspection.id, NEW_ID);
    assert.equal(r.body.inspection.startedBy, USERS.inspector!.id);
    assert.equal((await answer(c, 'inspector', NEW_ID, 'q_helmet', 'no')).status, 200);
  });
});

test('the same start request sent twice (first answer lost) gives back the same inspection and creates nothing new', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    const first = await post(c, 'inspector', { id: NEW_ID, templateId, siteId: SITE_A, title: 'Night round' });
    const again = await post(c, 'inspector', { id: NEW_ID, templateId, siteId: SITE_A, title: 'Night round' });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.inspection, first.body.inspection);
    assert.deepEqual(await mine(c, 'inspector'), [NEW_ID], 'still exactly one');
  });
});

test('a replay does not touch answers already saved', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    await post(c, 'inspector', { id: NEW_ID, templateId, siteId: SITE_A });
    await answer(c, 'inspector', NEW_ID, 'q_helmet', 'no');
    assert.equal((await post(c, 'inspector', { id: NEW_ID, templateId, siteId: SITE_A })).status, 200);
    const got = (await c('inspector', 'GET', `/inspections/${NEW_ID}`)).body;
    assert.equal(got.responses.q_helmet.value, 'no');
  });
});

test('another person cannot take over an id that already exists, even in the same organisation', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    await post(c, 'inspector', { id: NEW_ID, templateId, siteId: SITE_A });
    const r = await post(c, 'inspector2', { id: NEW_ID, templateId, siteId: SITE_A });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'conflict');
    assert.deepEqual(await mine(c, 'inspector2'), []);
    assert.equal((await c('inspector', 'GET', `/inspections/${NEW_ID}`)).body.inspection.startedBy, USERS.inspector!.id);
  });
});

test('an id used by another organisation is refused with the same generic answer, and nothing is created', async () => {
  await run(async (c) => {
    const a = await publishedTemplate(c);
    await post(c, 'inspector', { id: NEW_ID, templateId: a.templateId, siteId: SITE_A });
    const tb = (await c('managerB', 'POST', '/templates', { name: { en: 'B template' }, content: batchingPlantTemplate() })).body;
    await c('managerB', 'POST', `/templates/${tb.template.id}/publish`, { version: tb.draftVersion });
    const r = await post(c, 'managerB', { id: NEW_ID, templateId: tb.template.id });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, (await post(c, 'inspector2', { id: NEW_ID, templateId: a.templateId, siteId: SITE_A })).body, 'same body: cannot tell "mine" from "theirs"');
    assert.deepEqual(await mine(c, 'managerB'), []);
  });
});

test('a replay by the same person for a DIFFERENT template is a conflict, not a silent success', async () => {
  await run(async (c) => {
    const a = await publishedTemplate(c);
    const b = await publishedTemplate(c);
    await post(c, 'inspector', { id: NEW_ID, templateId: a.templateId, siteId: SITE_A });
    assert.equal((await post(c, 'inspector', { id: NEW_ID, templateId: b.templateId, siteId: SITE_A })).status, 409);
  });
});

test('a malformed id or version is refused before anything is created', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    const bad = await post(c, 'inspector', { id: 'not-a-uuid', templateId, siteId: SITE_A });
    assert.equal(bad.status, 422);
    assert.deepEqual(bad.body.errors.id, [{ code: 'invalid_type' }]);
    assert.equal((await post(c, 'inspector', { id: NEW_ID, templateId, templateVersionId: 'x', siteId: SITE_A })).status, 422);
    assert.deepEqual(await mine(c, 'inspector'), []);
  });
});

test('the version the app filled in must be a published version of THAT template', async () => {
  await run(async (c) => {
    const a = await publishedTemplate(c);
    const b = await publishedTemplate(c);
    const unknown = await post(c, 'inspector', { id: NEW_ID, templateId: a.templateId, templateVersionId: OTHER_ID, siteId: SITE_A });
    assert.equal(unknown.status, 422);
    assert.deepEqual(unknown.body.errors.templateVersionId, [{ code: 'invalid_reference' }]);
    const foreign = await post(c, 'inspector', { id: NEW_ID, templateId: a.templateId, templateVersionId: b.versionId, siteId: SITE_A });
    assert.equal(foreign.status, 422, "another template's version");
    const draft = (await c('manager', 'POST', `/templates/${a.templateId}/drafts`)).body.version;
    assert.equal((await post(c, 'inspector', { id: NEW_ID, templateId: a.templateId, templateVersionId: draft.id, siteId: SITE_A })).status, 422, 'a draft is not usable');
    assert.deepEqual(await mine(c, 'inspector'), []);
  });
});

test('the template was re-published while the app was offline: the inspection keeps the version the app used', async () => {
  await run(async (c) => {
    const { templateId, versionId: v1 } = await publishedTemplate(c);
    const draft = (await c('manager', 'POST', `/templates/${templateId}/drafts`)).body.version;
    const v2 = (await c('manager', 'POST', `/templates/${templateId}/publish`, { version: draft.version })).body.version.id as string;
    assert.notEqual(v1, v2);
    const pinned = await post(c, 'inspector', { id: NEW_ID, templateId, templateVersionId: v1, siteId: SITE_A });
    assert.equal(pinned.status, 201);
    assert.equal(pinned.body.inspection.templateVersionId, v1);
    const online = await start(c, 'inspector', templateId);
    assert.equal(online.templateVersionId, v2, 'without a pinned version the newest published one is used, as before');
  });
});

test('permissions are unchanged: a viewer cannot start an inspection, with or without an id', async () => {
  await run(async (c) => {
    const { templateId } = await publishedTemplate(c);
    assert.equal((await post(c, 'viewer', { id: NEW_ID, templateId, siteId: SITE_A })).status, 403);
    assert.equal((await post(c, 'viewer', { templateId, siteId: SITE_A })).status, 403);
  });
});

test('starting without an id still works exactly as before', async () => {
  await run(async (c) => {
    const { templateId, versionId } = await publishedTemplate(c);
    const i = await start(c, 'inspector', templateId);
    assert.ok(i.id && i.id !== NEW_ID);
    assert.equal(i.templateVersionId, versionId);
  });
});
