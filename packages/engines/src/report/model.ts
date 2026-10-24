// Builds the language-specific, display-ready report model from stored inspection data. Pure and deterministic.
import type { Question } from '../template/types.ts';
import { localized, optionValues } from '../template/types.ts';
import { label, labelOrRaw } from './labels.ts';
import type { ReportLocale } from './labels.ts';
import type { QuestionRow, ReportInput, ReportModel, ReportLink } from './types.ts';

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

/** 'YYYY-MM-DD HH:mm' in the given time zone (locale independent, unambiguous for Arabic and English readers). */
export function formatDateTime(iso: string, timeZone = 'Africa/Cairo'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

export const formatDate = (iso: string, timeZone?: string) => formatDateTime(iso, timeZone).slice(0, 10);

const pct = (n: number | null): string => (n === null ? '—' : `${n}%`);

export function answerText(q: Question, value: unknown, locale: ReportLocale): string {
  if (isBlank(value)) return label(locale, 'answer.none');
  switch (q.responseType) {
    case 'yes_no': case 'yes_no_na': case 'pass_fail_na': case 'good_fair_poor_na':
      return labelOrRaw(locale, 'answer', String(value));
    case 'multiple_choice': case 'multiple_select': {
      const known = new Map((q.options ?? []).map((o) => [o.value, localized(o.label, locale)]));
      const vals = Array.isArray(value) ? value.map(String) : [String(value)];
      return vals.map((v) => known.get(v) || v).join(locale === 'ar' ? '، ' : ', ');
    }
    case 'checkbox': return label(locale, value === true ? 'answer.true' : 'answer.false');
    case 'rating': return `${String(value)} / ${q.ratingMax ?? 5}`;
    case 'photo': case 'video': case 'audio': case 'file':
      return label(locale, 'answer.attachments', { n: Array.isArray(value) ? value.length : 1 });
    case 'gps': case 'location': {
      const g = value as { lat?: number; lng?: number };
      return typeof g.lat === 'number' && typeof g.lng === 'number' ? `${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}` : String(value);
    }
    case 'signature': return '✓';
    default: return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

export function buildReport(input: ReportInput, locale: ReportLocale): ReportModel {
  const tz = input.timeZone ?? 'Africa/Cairo';
  const { inspection: ins, template, evaluation, answers } = input;
  const storedSeverity = new Map(input.flags.map((f) => [f.questionId, f.severity]));
  const templateName = localized(template.name, locale);
  const title = ins.title?.trim() || templateName;

  // question rows, grouped page -> section, numbered across the whole report, hidden questions omitted
  let no = 0;
  const numberOf = new Map<string, number>();
  const titleOf = new Map<string, string>();
  const answerOf = new Map<string, string>();
  const rowOf = (q: Question): QuestionRow => {
    const value = answers[q.id];
    no++;
    numberOf.set(q.id, no);
    titleOf.set(q.id, localized(q.title, locale) || q.id);
    const text = answerText(q, value, locale);
    answerOf.set(q.id, text);
    const s = evaluation.scores.perQuestion[q.id];
    return {
      no, id: q.id, title: titleOf.get(q.id)!, answer: text, unanswered: isBlank(value),
      scoreText: s ? `${s.earned}/${s.max}` : null, severity: storedSeverity.get(q.id) ?? null, photos: input.media?.[q.id]?.photos ?? [],
    };
  };

  const pages: ReportModel['pages'] = [];
  for (const page of template.content.pages) {
    if (!evaluation.state.visible[page.id]) continue;
    const blocks: ReportModel['pages'][number]['blocks'] = [];
    let loose: QuestionRow[] = [];
    const flush = () => { if (loose.length) blocks.push({ sectionTitle: null, rows: loose }); loose = []; };
    for (const item of page.items) {
      if (item.kind === 'question') {
        if (evaluation.state.visible[item.id]) loose.push(rowOf(item));
      } else if (item.kind === 'section') {
        if (!evaluation.state.visible[item.id]) continue;
        flush();
        const rows = item.items.filter((x): x is Question => x.kind === 'question' && !!evaluation.state.visible[x.id]).map(rowOf);
        if (rows.length) blocks.push({ sectionTitle: localized(item.title, locale) || item.id, rows });
      }
    }
    flush();
    if (blocks.length) pages.push({ id: page.id, title: localized(page.title, locale) || page.id, blocks });
  }

  const byId = (links: ReportLink[]) => new Map(links.map((l) => [l.id, l]));
  const actionsById = byId(input.actions);
  const issuesById = byId(input.issues);
  const flagged = input.flags
    .map((f) => ({ f, no: numberOf.get(f.questionId) }))
    .filter((x): x is { f: ReportInput['flags'][number]; no: number } => x.no !== undefined)
    .sort((a, b) => a.no - b.no)
    .map(({ f, no: n }) => ({
      no: n, title: titleOf.get(f.questionId)!, answer: answerOf.get(f.questionId)!, severity: f.severity,
      links: [
        ...(f.actionId && actionsById.has(f.actionId) ? [{ kind: 'action' as const, title: actionsById.get(f.actionId)!.title }] : []),
        ...(f.issueId && issuesById.has(f.issueId) ? [{ kind: 'issue' as const, title: issuesById.get(f.issueId)!.title }] : []),
      ],
    }));

  const decorate = (l: ReportLink) => ({ ...l, statusText: labelOrRaw(locale, 'status', l.status), priorityText: labelOrRaw(locale, 'priority', l.priority) });
  const completed = ins.completedAt ?? ins.startedAt;

  return {
    locale, dir: locale === 'ar' ? 'rtl' : 'ltr', title, confidential: input.confidential,
    cover: {
      orgName: input.orgName, title, templateName, version: template.versionNo, siteName: ins.siteName,
      date: formatDate(completed, tz), reportNo: ins.id.slice(0, 8).toUpperCase(),
    },
    meta: [
      { label: label(locale, 'meta.conductedBy'), value: ins.startedByName },
      { label: label(locale, 'report.site'), value: ins.siteName ?? '—' },
      { label: label(locale, 'meta.startedAt'), value: formatDateTime(ins.startedAt, tz) },
      { label: label(locale, 'meta.completedAt'), value: ins.completedAt ? formatDateTime(ins.completedAt, tz) : '—' },
    ],
    summary: {
      pct: ins.scorePct, earned: ins.scoreEarned, possible: ins.scorePossible,
      result: ins.passed === null ? 'notScored' : ins.passed ? 'passed' : 'failed',
      flaggedCount: input.flags.length, flaggedRate: ins.flaggedRate,
      actionsCount: input.actions.length, issuesCount: input.issues.length,
    },
    pages, flagged,
    actions: input.actions.map(decorate), issues: input.issues.map(decorate),
    signatures: input.signatures.map((s) => ({ name: s.name, role: s.role ?? null, signedAt: formatDateTime(s.signedAt, tz), imageDataUri: s.imageDataUri ?? null })),
  };
}

export { optionValues, pct };
