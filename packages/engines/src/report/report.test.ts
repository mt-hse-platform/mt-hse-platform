import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchingPlantTemplate } from '../template/fixtures.ts';
import { evaluateInspection } from '../template/scoring.ts';
import type { Question } from '../template/types.ts';
import { REPORT_LABELS } from './labels.ts';
import { answerText, buildReport, formatDateTime } from './model.ts';
import { esc, renderReportHtml } from './html.ts';
import { validateReportInput } from './validate.ts';
import type { ReportInput } from './types.ts';

const ANSWERS = { q_helmet: 'no', q_vest: 'no', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 };

function input(over: Partial<ReportInput> = {}, answers: Record<string, unknown> = ANSWERS): ReportInput {
  const content = batchingPlantTemplate();
  const ev = evaluateInspection(content, answers);
  return {
    orgName: 'Reliance Ready Mix',
    inspection: {
      id: 'abcdef12-0000-0000-0000-000000000000', title: null, status: 'completed',
      startedAt: '2026-10-03T08:00:00Z', completedAt: '2026-10-03T10:00:00Z', siteName: 'Station A', startedByName: 'Mohamed Taher',
      scorePct: ev.scores.total.pct, scoreEarned: ev.scores.total.earned, scorePossible: ev.scores.total.possible,
      passed: ev.scores.passed, flaggedRate: ev.flaggedRate,
    },
    template: { name: { ar: 'تفتيش محطة الخرسانة', en: 'Batching plant inspection' }, versionNo: 2, content },
    answers: ev.answers,
    evaluation: { state: ev.state, scores: ev.scores, flags: ev.flags },
    flags: ev.flags.map((f, i) => ({ questionId: f.questionId, severity: f.severity, issueId: null, actionId: i === 0 ? 'act-1' : null })),
    actions: [{ id: 'act-1', title: 'Provide helmets', status: 'in_progress', priority: 'high', assigneeName: 'Ahmed', dueDate: '2026-10-10', questionId: 'q_helmet' }],
    issues: [],
    signatures: [],
    confidential: true,
    ...over,
  };
}

test('report labels: Arabic and English have the same keys and placeholders, nothing empty', () => {
  const en = REPORT_LABELS.en; const ar = REPORT_LABELS.ar;
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(en) as (keyof typeof en)[]) {
    assert.ok(ar[k].trim().length > 0, k);
    assert.deepEqual(ph(ar[k]), ph(en[k]), k);
  }
});

test('dates are shown in the organization time zone in an unambiguous format', () => {
  assert.equal(formatDateTime('2026-10-03T10:00:00Z', 'UTC'), '2026-10-03 10:00');
  assert.equal(formatDateTime('2026-10-03T10:00:00Z', 'Africa/Cairo'), '2026-10-03 13:00');
  assert.equal(formatDateTime('2026-10-03T23:30:00Z', 'Africa/Cairo'), '2026-10-04 02:30', 'crosses midnight');
  assert.equal(formatDateTime('not a date'), 'not a date');
});

test('answer text per response type, in both languages', () => {
  const q = (o: Partial<Question>): Question => ({ kind: 'question', id: 'q', title: { en: 'Q' }, responseType: 'text', ...o } as Question);
  assert.equal(answerText(q({ responseType: 'yes_no_na' }), 'na', 'en'), 'N/A');
  assert.equal(answerText(q({ responseType: 'yes_no_na' }), 'na', 'ar'), 'لا ينطبق');
  assert.equal(answerText(q({ responseType: 'pass_fail_na' }), 'fail', 'ar'), 'غير مطابق');
  const mc = q({ responseType: 'multiple_choice', options: [{ value: 'a', label: { ar: 'أ', en: 'Alpha' } }, { value: 'b', label: { en: 'Beta' } }] });
  assert.equal(answerText(mc, 'a', 'ar'), 'أ');
  assert.equal(answerText(mc, 'b', 'ar'), 'Beta', 'falls back to the other language');
  assert.equal(answerText(q({ ...mc, responseType: 'multiple_select' }), ['a', 'b'], 'en'), 'Alpha, Beta');
  assert.equal(answerText(q({ ...mc, responseType: 'multiple_select' }), ['a', 'b'], 'ar'), 'أ، Beta');
  assert.equal(answerText(q({ responseType: 'checkbox' }), false, 'en'), 'No');
  assert.equal(answerText(q({ responseType: 'rating', ratingMax: 10 }), 7, 'en'), '7 / 10');
  assert.equal(answerText(q({ responseType: 'photo' }), ['m1', 'm2', 'm3'], 'en'), '3 attachment(s)');
  assert.equal(answerText(q({ responseType: 'gps' }), { lat: 30.0444, lng: 31.2357 }, 'en'), '30.04440, 31.23570');
  assert.equal(answerText(q({ responseType: 'number' }), 0, 'en'), '0', 'zero is an answer');
  assert.equal(answerText(q({}), '', 'en'), 'Not answered');
  assert.equal(answerText(q({}), undefined, 'ar'), 'بدون إجابة');
});

test('model: numbering, hidden questions omitted, scores and flagged items with their links', () => {
  const m = buildReport(input(), 'en');
  assert.equal(m.dir, 'ltr');
  assert.equal(m.title, 'Batching plant inspection');
  assert.equal(m.cover.reportNo, 'ABCDEF12');
  assert.equal(m.cover.date, '2026-10-03');
  assert.equal(m.cover.version, 2);

  const rows = m.pages.flatMap((p) => p.blocks.flatMap((b) => b.rows));
  assert.deepEqual(rows.map((r) => r.no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(!rows.some((r) => r.id === 'q_welding_screen'), 'hidden by a condition');
  assert.equal(m.pages.length, 2, 'the emergency page is hidden');
  assert.equal(rows.find((r) => r.id === 'q_helmet')!.answer, 'No');
  assert.equal(rows.find((r) => r.id === 'q_rating')!.answer, '5 / 5');
  assert.equal(rows.find((r) => r.id === 'q_rating')!.scoreText, '5/5');
  assert.equal(rows.find((r) => r.id === 'q_pressure')!.unanswered, true);
  assert.equal(rows.find((r) => r.id === 'q_helmet')!.severity, 'high');

  assert.deepEqual(m.summary, {
    pct: 40.59, earned: 205, possible: 505, result: 'failed', flaggedCount: 2, flaggedRate: 40, actionsCount: 1, issuesCount: 0,
  });
  assert.deepEqual(m.flagged.map((f) => [f.no, f.severity, f.links.map((l) => `${l.kind}:${l.title}`)]), [
    [1, 'high', ['action:Provide helmets']], [2, 'medium', []],
  ]);
  assert.equal(m.actions[0]!.statusText, 'In progress');
  assert.equal(m.actions[0]!.priorityText, 'High');
  assert.deepEqual(m.meta.map((x) => x.value), ['Mohamed Taher', 'Station A', '2026-10-03 11:00', '2026-10-03 13:00']);
});

test('model in Arabic: right-to-left, Arabic titles and answers, Arabic status labels', () => {
  const m = buildReport(input(), 'ar');
  assert.equal(m.dir, 'rtl');
  assert.equal(m.title, 'تفتيش محطة الخرسانة');
  const first = m.pages[0]!.blocks[0]!.rows[0]!;
  assert.equal(first.title, 'هل الجميع يرتدي الخوذة؟');
  assert.equal(first.answer, 'لا');
  assert.equal(m.actions[0]!.statusText, 'قيد التنفيذ');
  assert.equal(m.pages[0]!.title, 'عام');
});

test('inspection title overrides the template name on the cover', () => {
  const i = input(); i.inspection.title = '  Morning round  ';
  assert.equal(buildReport(i, 'en').cover.title, 'Morning round');
});

test('HTML: direction, language, structure, confidentiality, no scripts and no external resources', () => {
  const en = renderReportHtml(buildReport(input(), 'en'));
  const ar = renderReportHtml(buildReport(input(), 'ar'));
  assert.match(en, /<html lang="en" dir="ltr">/);
  assert.match(ar, /<html lang="ar" dir="rtl">/);
  for (const html of [en, ar]) {
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(!/<script/i.test(html), 'no scripts');
    assert.ok(!/https?:\/\//i.test(html), 'no external resources');
    assert.ok(!/<link\b/i.test(html) && !/<img\b/i.test(html));
    assert.equal((html.match(/<table/g) ?? []).length, (html.match(/<\/table>/g) ?? []).length);
    assert.ok(html.includes('<thead>'));
  }
  assert.ok(en.includes('<th>Version</th><td><bdi>2</bdi></td>'), 'version has its own row');
  assert.ok(en.includes("html[dir='rtl'] body"), 'explicit alignment rules for both directions');
  assert.ok(en.includes('Private &amp; Confidential'));
  assert.ok(ar.includes('سري وخاص'));
  assert.ok(ar.includes('تقرير التفتيش'));
  assert.ok(en.includes('Critical') === false && en.includes('>High<'), 'severity is written as text, not only colour');
  const plain = renderReportHtml(buildReport(input({ confidential: false }), 'en'));
  assert.ok(!plain.includes('Confidential'));
});

test('HTML escapes every dynamic value (XSS)', () => {
  const evil = '<script>alert(1)</script>';
  const i = input({ orgName: '"><img src=x onerror=alert(1)>' });
  i.template.content.pages[0]!.title = { en: evil };
  (i.template.content.pages[0]!.items[0] as { title: { en: string } }).title = { en: evil };
  i.inspection.startedByName = evil;
  i.inspection.siteName = `'; DROP TABLE x; --`;
  i.actions[0]!.title = evil;
  i.actions[0]!.assigneeName = evil;
  const html = renderReportHtml(buildReport(i, 'en'));
  assert.ok(!html.includes('<script'), 'raw script tag');
  assert.ok(!html.includes('<img'), 'raw img tag');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(esc(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&#39;e&#39;');
});

test('HTML: empty sections show a message; signatures appear only when present', () => {
  const m = buildReport(input({ flags: [], actions: [], evaluation: { ...input().evaluation, flags: [] } }, { q_helmet: 'yes', q_vest: 'yes', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 }), 'en');
  const html = renderReportHtml(m);
  assert.ok(html.includes('No flagged items.') && html.includes('No actions.') && html.includes('No issues.'));
  assert.ok(!html.includes('Signatures'));
  const signed = renderReportHtml(buildReport(input({ signatures: [{ name: 'Mohamed Taher', role: 'Inspector', signedAt: '2026-10-03T10:05:00Z' }] }), 'en'));
  assert.ok(signed.includes('Signatures') && signed.includes('2026-10-03 13:05'));
});

test('report validation: complete data passes; missing pieces are reported', () => {
  assert.deepEqual(validateReportInput(input()), []);

  const open = input(); open.inspection.status = 'in_progress'; open.inspection.completedAt = null;
  assert.deepEqual(validateReportInput(open).map((x) => x.code).sort(), ['inspection_not_completed', 'missing_completion_date']);

  const missing = input({}, { q_vest: 'no' }); // required helmet answer is missing
  assert.ok(validateReportInput(missing).some((x) => x.code === 'missing_or_invalid_answer' && x.path === 'q_helmet'));

  const drift = input(); drift.flags = drift.flags.slice(1);
  assert.ok(validateReportInput(drift).some((x) => x.code === 'flag_missing'));
  const extra = input(); extra.flags = [...extra.flags, { questionId: 'q_rating', severity: 'low', issueId: null, actionId: null }];
  assert.ok(validateReportInput(extra).some((x) => x.code === 'flag_unexpected' && x.path === 'q_rating'));

  const sig = input({ signatures: [{ name: ' ', signedAt: 'yesterday' }] });
  assert.ok(validateReportInput(sig).some((x) => x.code === 'invalid_signature'));
});

// ---------- photos and signatures ----------

const JPEG_URI = `data:image/jpeg;base64,${Buffer.from('fake-jpeg-bytes').toString('base64')}`;
const PNG_URI = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;

test('photos and signature images are embedded as data URIs, nothing external', () => {
  const i = input({ signatures: [{ name: 'Mohamed Taher', role: 'Inspector', signedAt: '2026-10-03T10:05:00Z', imageDataUri: PNG_URI }] });
  i.media = { q_helmet: { expected: 2, photos: [{ dataUri: JPEG_URI, caption: 'Missing helmet' }, { dataUri: JPEG_URI, caption: null }] } };
  const html = renderReportHtml(buildReport(i, 'en'));
  assert.equal((html.match(/<img class="photo"/g) ?? []).length, 2);
  assert.ok(html.includes(`<img class="sign" src="${PNG_URI}" alt="Mohamed Taher">`));
  assert.ok(html.includes('alt="Missing helmet"'));
  assert.ok(html.includes('<th>Signature</th>'));
  assert.ok(!/https?:\/\//i.test(html), 'no external resources');
  assert.deepEqual(validateReportInput(i), []);
});

test('only strict base64 image data URIs ever reach an img tag (injection attempts are dropped)', () => {
  const i = input();
  i.media = { q_helmet: { expected: 4, photos: [
    { dataUri: 'https://evil.example/x.png', caption: null },
    { dataUri: 'javascript:alert(1)', caption: null },
    { dataUri: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', caption: null },
    { dataUri: `${JPEG_URI}" onerror="alert(1)`, caption: null },
  ] } };
  const html = renderReportHtml(buildReport(i, 'en'));
  assert.ok(!html.includes('<img'), 'none of them is rendered');
  assert.ok(!html.includes('evil.example') && !html.includes('onerror') && !html.includes('javascript:'));
  const alt = input(); alt.media = { q_helmet: { expected: 1, photos: [{ dataUri: JPEG_URI, caption: '"><script>alert(1)</script>' }] } };
  const h2 = renderReportHtml(buildReport(alt, 'en'));
  assert.ok(!h2.includes('<script') && h2.includes('alt="&quot;&gt;&lt;script&gt;'));
});

test('report validation: a photo that is referenced but cannot be loaded blocks the report', () => {
  const i = input();
  i.media = { q_helmet: { expected: 3, photos: [{ dataUri: JPEG_URI, caption: null }] }, q_vest: { expected: 1, photos: [{ dataUri: JPEG_URI, caption: null }] } };
  assert.deepEqual(validateReportInput(i), [{ code: 'missing_media', path: 'q_helmet' }]);
});
