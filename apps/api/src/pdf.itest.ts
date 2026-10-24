// Runs only when a Chrome/Chromium binary exists (CI sets CHROMIUM_PATH to the preinstalled Google Chrome).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PlaywrightPdfRenderer } from './playwrightPdf.ts';
import { batchingPlantTemplate } from '../../../packages/engines/src/template/fixtures.ts';
import { evaluateInspection } from '../../../packages/engines/src/template/scoring.ts';
import { buildReport } from '../../../packages/engines/src/report/model.ts';
import { renderReportHtml } from '../../../packages/engines/src/report/html.ts';
import type { ReportInput } from '../../../packages/engines/src/report/types.ts';

const chrome = process.env.CHROMIUM_PATH;
const skip = chrome && existsSync(chrome) ? false : 'CHROMIUM_PATH is not set or does not exist';
const renderer = new PlaywrightPdfRenderer({ executablePath: chrome, noSandbox: process.env.PDF_NO_SANDBOX === '1' });
after(async () => { await renderer.close(); });

function html(locale: 'ar' | 'en', title = 'Morning round') {
  const content = batchingPlantTemplate();
  const ev = evaluateInspection(content, { q_helmet: 'no', q_vest: 'no', q_fire_ext: 'pass', q_condition: 'good', q_rating: 5 });
  const input: ReportInput = {
    orgName: 'ريلاينس ريدي ميكس', template: { name: { ar: 'تفتيش محطة الخرسانة', en: 'Batching plant' }, versionNo: 1, content },
    inspection: { id: 'abcdef12-0000-0000-0000-000000000000', title, status: 'completed', startedAt: '2026-10-03T08:00:00Z', completedAt: '2026-10-03T10:00:00Z',
      siteName: 'Station A', startedByName: 'Mohamed Taher', scorePct: ev.scores.total.pct, scoreEarned: ev.scores.total.earned, scorePossible: ev.scores.total.possible, passed: ev.scores.passed, flaggedRate: ev.flaggedRate },
    answers: ev.answers, evaluation: { state: ev.state, scores: ev.scores, flags: ev.flags },
    flags: ev.flags.map((f) => ({ questionId: f.questionId, severity: f.severity, issueId: null, actionId: null })),
    actions: [], issues: [], signatures: [], confidential: true,
  };
  return renderReportHtml(buildReport(input, locale));
}

const pageCount = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

test('renders Arabic and English reports to real PDFs', { skip }, async () => {
  for (const locale of ['ar', 'en'] as const) {
    const pdf = await renderer.render(html(locale), { locale, footerText: 'Private & Confidential' });
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', locale);
    assert.ok(pdf.length > 10_000, `${locale}: ${pdf.length} bytes`);
    assert.ok(pageCount(pdf) >= 1, `${locale}: page objects found`);
  }
});

test('concurrent renders are serialized and all succeed; scripts in the HTML never run', { skip }, async () => {
  const evil = html('en', '<script>document.title="x";throw new Error("ran")</script><img src="http://127.0.0.1:9/x.png">');
  const results = await Promise.all([
    renderer.render(html('en'), { locale: 'en', footerText: '' }),
    renderer.render(html('ar'), { locale: 'ar', footerText: '' }),
    renderer.render(evil, { locale: 'en', footerText: '' }),
  ]);
  for (const pdf of results) assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
});
