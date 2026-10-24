// Renders a report model as one self-contained HTML document (no scripts, no external resources).
// The same HTML is the web view and the source of the PDF. Every dynamic value is escaped.
import { label } from './labels.ts';
import type { ReportLabelKey } from './labels.ts';
import { pct } from './model.ts';
import type { ReportModel } from './types.ts';

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Isolates user-provided text so it cannot reorder surrounding Arabic/English text. */
const bdi = (value: unknown) => `<bdi>${esc(value)}</bdi>`;

const CSS = `
@page { size: A4; margin: 16mm 14mm; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html[dir='rtl'] body { direction: rtl; text-align: right; }
html[dir='ltr'] body { direction: ltr; text-align: left; }
html[dir='rtl'] th, html[dir='rtl'] td { text-align: right; }
html[dir='ltr'] th, html[dir='ltr'] td { text-align: left; }
body { font-family: 'Cairo','Noto Naskh Arabic','Noto Sans Arabic','Segoe UI',Tahoma,'DejaVu Sans',Arial,sans-serif; font-size: 11pt; line-height: 1.5; color: #14161c; background: #fff; }
h1 { font-size: 22pt; margin: 0 0 6pt; } h2 { font-size: 14pt; margin: 18pt 0 8pt; padding-bottom: 3pt; border-bottom: 2px solid #5a49e8; page-break-after: avoid; break-after: avoid; }
h3 { font-size: 12pt; margin: 12pt 0 6pt; page-break-after: avoid; break-after: avoid; }
.muted { color: #596273; }
.cover { padding: 30mm 0 10mm; page-break-after: always; text-align: center; }
.cover .org { font-size: 14pt; color: #596273; margin-bottom: 18pt; }
.cover .meta { margin: 24pt auto 0; width: 70%; }
.cover .conf { margin-top: 30pt; font-weight: bold; letter-spacing: 1px; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; }
th, td { border: 1px solid #c9ccd6; padding: 5pt 7pt; vertical-align: top; text-align: start; }
th { background: #eceef4; font-weight: bold; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; break-inside: avoid; }
.kv th { width: 34%; }
.badge { display: inline-block; padding: 1pt 7pt; border: 1.5px solid #596273; border-radius: 10pt; font-size: 9.5pt; font-weight: bold; white-space: nowrap; }
.sev-low { border-color: #1c8a56; color: #1c8a56; } .sev-medium { border-color: #8f6a00; color: #8f6a00; }
.sev-high { border-color: #c7343a; color: #c7343a; } .sev-critical { border-color: #7a0f14; color: #fff; background: #7a0f14; }
.unanswered { color: #596273; font-style: italic; }
.num { white-space: nowrap; width: 8%; }
.pass { color: #1c8a56; font-weight: bold; } .fail { color: #c7343a; font-weight: bold; }
.empty { color: #596273; padding: 6pt 0; }
.photos { padding: 4pt 0; } .photo { max-width: 52mm; max-height: 52mm; margin: 2mm; border: 1px solid #c9ccd6; }
.sign { max-width: 45mm; max-height: 18mm; }
.foot { margin-top: 24pt; text-align: center; font-weight: bold; }
`;

/** Only strict base64 data URIs of the allowed image types are ever placed in an <img src>. */
const SAFE_DATA_URI = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const img = (uri: string, alt: string, cls: string) => (SAFE_DATA_URI.test(uri) ? `<img class="${cls}" src="${uri}" alt="${esc(alt)}">` : '');

const th = (loc: ReportModel['locale'], keys: ReportLabelKey[]) =>
  `<thead><tr>${keys.map((k) => `<th>${esc(label(loc, k))}</th>`).join('')}</tr></thead>`;

export function renderReportHtml(m: ReportModel): string {
  const L = (k: ReportLabelKey, p?: Record<string, string | number>) => label(m.locale, k, p);
  const badge = (sev: string) => `<span class="badge sev-${esc(sev)}">${esc(L(`severity.${sev}` as ReportLabelKey))}</span>`;
  const out: string[] = [];

  out.push(`<section class="cover">
<div class="org">${bdi(m.cover.orgName)}</div>
<h1>${esc(L('report.title'))}</h1>
<h2 style="border:0">${bdi(m.cover.title)}</h2>
<table class="kv cover meta" style="page-break-after:auto;padding:0;text-align:start"><tbody>
<tr><th>${esc(L('report.template'))}</th><td>${bdi(m.cover.templateName)}</td></tr>
<tr><th>${esc(L('report.version'))}</th><td>${bdi(m.cover.version)}</td></tr>
<tr><th>${esc(L('report.site'))}</th><td>${bdi(m.cover.siteName ?? '—')}</td></tr>
<tr><th>${esc(L('report.date'))}</th><td>${bdi(m.cover.date)}</td></tr>
<tr><th>${esc(L('report.reportNo'))}</th><td>${bdi(m.cover.reportNo)}</td></tr>
</tbody></table>
${m.confidential ? `<div class="conf">${esc(L('report.confidential'))}</div>` : ''}
</section>`);

  out.push(`<h2>${esc(L('meta.title'))}</h2><table class="kv"><tbody>${m.meta.map((r) => `<tr><th>${esc(r.label)}</th><td>${bdi(r.value)}</td></tr>`).join('')}</tbody></table>`);

  const s = m.summary;
  const resultClass = s.result === 'passed' ? 'pass' : s.result === 'failed' ? 'fail' : '';
  out.push(`<h2>${esc(L('summary.title'))}</h2><table class="kv"><tbody>
<tr><th>${esc(L('summary.score'))}</th><td>${bdi(pct(s.pct))}</td></tr>
<tr><th>${esc(L('summary.points'))}</th><td>${bdi(s.earned === null ? '—' : `${s.earned} / ${s.possible}`)}</td></tr>
<tr><th>${esc(L('summary.result'))}</th><td class="${resultClass}">${esc(L(`result.${s.result}` as ReportLabelKey))}</td></tr>
<tr><th>${esc(L('summary.flagged'))}</th><td>${bdi(s.flaggedCount)}</td></tr>
<tr><th>${esc(L('summary.flaggedRate'))}</th><td>${bdi(pct(s.flaggedRate))}</td></tr>
<tr><th>${esc(L('summary.actions'))}</th><td>${bdi(s.actionsCount)}</td></tr>
<tr><th>${esc(L('summary.issues'))}</th><td>${bdi(s.issuesCount)}</td></tr>
</tbody></table>`);

  out.push(`<h2>${esc(L('section.questions'))}</h2>`);
  for (const page of m.pages) {
    out.push(`<h3>${bdi(page.title)}</h3>`);
    for (const block of page.blocks) {
      if (block.sectionTitle) out.push(`<p class="muted"><b>${bdi(block.sectionTitle)}</b></p>`);
      out.push(`<table>${th(m.locale, ['col.no', 'col.question', 'col.answer', 'col.score', 'col.severity'])}<tbody>${block.rows.map((r) =>
        `<tr><td class="num">${bdi(r.no)}</td><td>${bdi(r.title)}</td><td class="${r.unanswered ? 'unanswered' : ''}">${bdi(r.answer)}</td><td class="num">${bdi(r.scoreText ?? '—')}</td><td>${r.severity ? badge(r.severity) : '—'}</td></tr>${r.photos.length ? `<tr><td></td><td colspan="4" class="photos">${r.photos.map((p) => img(p.dataUri, p.caption ?? r.title, 'photo')).join('')}</td></tr>` : ''}`).join('')}</tbody></table>`);
    }
  }

  out.push(`<h2>${esc(L('section.flagged'))}</h2>`);
  out.push(m.flagged.length === 0 ? `<div class="empty">${esc(L('empty.flagged'))}</div>` :
    `<table>${th(m.locale, ['col.no', 'col.question', 'col.answer', 'col.severity', 'col.linked'])}<tbody>${m.flagged.map((f) =>
      `<tr><td class="num">${bdi(f.no)}</td><td>${bdi(f.title)}</td><td>${bdi(f.answer)}</td><td>${badge(f.severity)}</td><td>${f.links.length === 0 ? esc(L('link.none')) : f.links.map((l) => `${esc(L(l.kind === 'action' ? 'link.action' : 'link.issue'))}: ${bdi(l.title)}`).join('<br>')}</td></tr>`).join('')}</tbody></table>`);

  const linkTable = (rows: ReportModel['actions']) => `<table>${th(m.locale, ['col.title', 'col.status', 'col.priority', 'col.assignee', 'col.due'])}<tbody>${rows.map((r) =>
    `<tr><td>${bdi(r.title)}</td><td>${esc(r.statusText)}</td><td>${esc(r.priorityText)}</td><td>${bdi(r.assigneeName ?? '—')}</td><td>${bdi(r.dueDate ?? '—')}</td></tr>`).join('')}</tbody></table>`;
  out.push(`<h2>${esc(L('section.actions'))}</h2>${m.actions.length ? linkTable(m.actions) : `<div class="empty">${esc(L('empty.actions'))}</div>`}`);
  out.push(`<h2>${esc(L('section.issues'))}</h2>${m.issues.length ? linkTable(m.issues) : `<div class="empty">${esc(L('empty.issues'))}</div>`}`);

  if (m.signatures.length) {
    out.push(`<h2>${esc(L('section.signatures'))}</h2><table>${th(m.locale, ['col.name', 'col.signature', 'col.signedAt'])}<tbody>${m.signatures.map((x) =>
      `<tr><td>${bdi(x.name)}${x.role ? ` — ${bdi(x.role)}` : ''}</td><td>${x.imageDataUri ? img(x.imageDataUri, x.name, 'sign') : '—'}</td><td>${bdi(x.signedAt)}</td></tr>`).join('')}</tbody></table>`);
  }
  if (m.confidential) out.push(`<div class="foot">${esc(L('report.confidential'))}</div>`);

  return `<!doctype html>
<html lang="${esc(m.locale)}" dir="${esc(m.dir)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)}</title>
<style>${CSS}</style>
</head>
<body>
${out.join('\n')}
</body>
</html>`;
}
