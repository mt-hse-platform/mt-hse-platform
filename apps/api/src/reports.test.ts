import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from './server.ts';
import { MemoryWorkRepo } from './memoryWorkRepo.ts';
import { DEFAULT_ROLE_GRANTS } from '../../../packages/shared/src/permissions.ts';
import type { RoleKey } from '../../../packages/shared/src/permissions.ts';
import { batchingPlantTemplate } from '../../../packages/engines/src/template/fixtures.ts';
import type { IdentityStore, MembershipRecord, PdfRenderer, TokenVerifier } from './ports.ts';

const ORG_A = '00000000-0000-0000-0000-00000000aaaa';
const ORG_B = '00000000-0000-0000-0000-00000000bbbb';
const SITE_A = '00000000-0000-0000-0000-0000000051a1';

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

type R = { status: number; body: any; text: string; headers: Headers };
type Client = (who: string | null, method: string, path: string, body?: unknown) => Promise<R>;
type PdfCall = { html: string; locale: string; footerText: string };

async function run(fn: (c: Client, repo: MemoryWorkRepo, pdfCalls: PdfCall[]) => Promise<void>, withPdf = true) {
  const repo = new MemoryWorkRepo();
  for (const u of Object.values(USERS)) repo.addMember(u.org, u.id);
  repo.orgNames[ORG_A] = 'Reliance Ready Mix';
  repo.siteNames[SITE_A] = 'Station A';
  repo.userNames[USERS.inspector!.id] = 'Mohamed Taher';
  repo.userNames[USERS.employee!.id] = 'Ahmed Ali';
  const pdfCalls: PdfCall[] = [];
  const pdf: PdfRenderer = { async render(html, o) { pdfCalls.push({ html, locale: o.locale, footerText: o.footerText }); return Buffer.from('%PDF-1.7 fake'); } };
  const server = createApi({
    verifier, store, work: repo, pdf: withPdf ? pdf : undefined, logger: { error: () => undefined },
    clock: { now: () => new Date('2026-10-03T10:00:00Z'), today: () => '2026-10-03' },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c: Client = async (who, method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { ...(who ? { authorization: `Bearer tok-${who}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* html / pdf */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  try { await fn(c, repo, pdfCalls); } finally { await new Promise((r) => server.close(r)); }
}

async function finishedInspection(c: Client, title?: string) {
  const t = (await c('manager', 'POST', '/templates', { name: { ar: 'تفتيش محطة الخرسانة', en: 'Batching plant inspection' }, content: batchingPlantTemplate() })).body;
  await c('manager', 'POST', `/templates/${t.template.id}/publish`, { version: t.draftVersion });
  const i = (await c('inspector', 'POST', '/inspections', { templateId: t.template.id, siteId: SITE_A, title })).body.inspection;
  for (const [q, v] of Object.entries({ q_helmet: 'no', q_vest: 'no', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 })) {
    assert.equal((await c('inspector', 'PUT', `/inspections/${i.id}/responses/${q}`, { value: v, baseVersion: 0 })).status, 200);
  }
  const done = await c('inspector', 'POST', `/inspections/${i.id}/complete`);
  assert.equal(done.status, 200, done.text);
  return { id: i.id as string, flags: done.body.flags as { id: string; questionId: string }[] };
}

test('web report: HTML for a finished inspection, in the requested language, with safe headers', async () => {
  await run(async (c) => {
    const f = await finishedInspection(c);
    const en = await c('inspector', 'GET', `/inspections/${f.id}/report?lang=en`);
    assert.equal(en.status, 200);
    assert.equal(en.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(en.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.equal(en.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(en.headers.get('cache-control'), 'no-store');
    assert.ok(en.text.includes('<html lang="en" dir="ltr">'));
    for (const piece of ['Reliance Ready Mix', 'Inspection Report', 'Batching plant inspection', 'Station A', 'Mohamed Taher', 'Is everyone wearing a helmet?', '40.59%', 'Private &amp; Confidential']) {
      assert.ok(en.text.includes(piece), piece);
    }
    const ar = await c('inspector', 'GET', `/inspections/${f.id}/report`);
    assert.ok(ar.text.includes('<html lang="ar" dir="rtl">'), 'defaults to the user language');
    assert.ok(ar.text.includes('تقرير التفتيش') && ar.text.includes('تفتيش محطة الخرسانة'));
    assert.ok(!(await c('inspector', 'GET', `/inspections/${f.id}/report?confidential=0&lang=en`)).text.includes('Confidential'));
  });
});

test('report is refused for unfinished inspections and bad parameters; hidden from people without access', async () => {
  await run(async (c) => {
    const t = (await c('manager', 'POST', '/templates', { name: { en: 'T' }, content: batchingPlantTemplate() })).body;
    await c('manager', 'POST', `/templates/${t.template.id}/publish`, { version: t.draftVersion });
    const open = (await c('inspector', 'POST', '/inspections', { templateId: t.template.id, siteId: SITE_A })).body.inspection;
    assert.equal((await c('inspector', 'GET', `/inspections/${open.id}/report`)).body.code, 'not_completed');

    const f = await finishedInspection(c);
    assert.equal((await c('inspector', 'GET', `/inspections/${f.id}/report?lang=fr`)).status, 422);
    assert.equal((await c('inspector', 'GET', `/inspections/${f.id}/report?confidential=yes`)).status, 422);
    assert.equal((await c(null, 'GET', `/inspections/${f.id}/report`)).status, 401);
    assert.equal((await c('viewer', 'GET', `/inspections/${f.id}/report`)).status, 200, 'viewer of the site');
    assert.equal((await c('supervisor', 'GET', `/inspections/${f.id}/report`)).status, 200);
    assert.equal((await c('inspector2', 'GET', `/inspections/${f.id}/report`)).status, 404);
    assert.equal((await c('employee', 'GET', `/inspections/${f.id}/report`)).status, 404);
    assert.equal((await c('managerB', 'GET', `/inspections/${f.id}/report`)).status, 404);
    assert.equal((await c('inspector', 'GET', '/inspections/00000000-0000-0000-0000-00000000dead/report')).status, 404);
  });
});

test('report lists linked actions and issues, but only those the viewer may read', async () => {
  await run(async (c) => {
    const f = await finishedInspection(c);
    const helmet = f.flags.find((x) => x.questionId === 'q_helmet')!.id;
    const vest = f.flags.find((x) => x.questionId === 'q_vest')!.id;
    // the inspector creates an action (owner = inspector); the manager creates one assigned to an employee (owner = manager)
    assert.equal((await c('inspector', 'POST', `/inspections/${f.id}/flags/${helmet}/action`, { title: 'Provide helmets' })).status, 201);
    assert.equal((await c('manager', 'POST', `/inspections/${f.id}/flags/${vest}/action`, { title: 'Order vests', assigneeId: USERS.employee!.id, dueDate: '2026-10-20' })).status, 201);
    assert.equal((await c('inspector', 'POST', `/inspections/${f.id}/flags/${helmet}/issue`, { title: 'Helmet policy gap' })).status, 201);

    const asInspector = (await c('inspector', 'GET', `/inspections/${f.id}/report?lang=en`)).text;
    assert.ok(asInspector.includes('Provide helmets') && asInspector.includes('Helmet policy gap'));
    assert.ok(!asInspector.includes('Order vests'), 'inspector cannot read the manager-owned action');

    const asManager = (await c('manager', 'GET', `/inspections/${f.id}/report?lang=en`)).text;
    assert.ok(asManager.includes('Provide helmets') && asManager.includes('Order vests') && asManager.includes('Ahmed Ali') && asManager.includes('2026-10-20'));
    assert.ok(asManager.includes('Action: <bdi>Provide helmets</bdi>'), 'flagged table links to the action');
    assert.ok(asManager.includes('Issue: <bdi>Helmet policy gap</bdi>'));
  });
});

test('report text coming from users is escaped', async () => {
  await run(async (c) => {
    const f = await finishedInspection(c, '<script>alert(1)</script>');
    const html = (await c('inspector', 'GET', `/inspections/${f.id}/report?lang=en`)).text;
    assert.ok(!html.includes('<script'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });
});

test('PDF: generated from the same HTML, downloaded with a safe file name, and audited', async () => {
  await run(async (c, _repo, calls) => {
    const f = await finishedInspection(c);
    const r = await c('inspector', 'GET', `/inspections/${f.id}/report.pdf?lang=en`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition')!, /^attachment; filename="inspection-[A-Z0-9]{8}\.pdf"$/);
    assert.ok(r.text.startsWith('%PDF-'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.locale, 'en');
    assert.equal(calls[0]!.footerText, 'Private & Confidential');
    const html = (await c('inspector', 'GET', `/inspections/${f.id}/report?lang=en`)).text;
    assert.equal(calls[0]!.html, html, 'web view and PDF come from the same HTML');

    await c('inspector', 'GET', `/inspections/${f.id}/report.pdf?lang=ar&confidential=0`);
    assert.equal(calls[1]!.footerText, '');
    assert.equal((await c('viewer', 'GET', `/inspections/${f.id}/report.pdf`)).status, 200);
    assert.equal((await c('inspector2', 'GET', `/inspections/${f.id}/report.pdf`)).status, 404);
    const tl = (await c('inspector', 'GET', `/inspections/${f.id}/timeline`)).body.items.map((e: any) => e.event);
    assert.equal(tl.filter((e: string) => e === 'report_generated').length, 3, 'every PDF export is recorded');
    assert.equal((await c('inspector', 'GET', `/inspections/${f.id}/report`)).status, 200);
    assert.equal(calls.length, 3, 'the web view does not call the PDF renderer');
  });
});

test('PDF is reported as unavailable when no renderer is configured; unfinished inspections never reach it', async () => {
  await run(async (c) => {
    const f = await finishedInspection(c);
    assert.equal((await c('inspector', 'GET', `/inspections/${f.id}/report.pdf`)).body.code, 'pdf_unavailable');
    assert.equal((await c('inspector', 'GET', `/inspections/${f.id}/report.pdf`)).status, 501);
    assert.equal((await c('inspector', 'GET', `/inspections/${f.id}/report`)).status, 200, 'the web view still works');
  }, false);
  await run(async (c, _repo, calls) => {
    const t = (await c('manager', 'POST', '/templates', { name: { en: 'T' }, content: batchingPlantTemplate() })).body;
    await c('manager', 'POST', `/templates/${t.template.id}/publish`, { version: t.draftVersion });
    const open = (await c('inspector', 'POST', '/inspections', { templateId: t.template.id })).body.inspection;
    assert.equal((await c('inspector', 'GET', `/inspections/${open.id}/report.pdf`)).status, 422);
    assert.equal(calls.length, 0);
  });
});
