// Report validation (runs before a report is generated): reports are only produced from complete, consistent data.
import { validateAnswers } from '../template/validate.ts';
import type { ReportInput } from './types.ts';

export type ReportIssue = { code: string; path: string };

export function validateReportInput(input: ReportInput): ReportIssue[] {
  const issues: ReportIssue[] = [];
  const add = (code: string, path = '') => issues.push({ code, path });
  const i = input.inspection;

  if (i.status !== 'completed' && i.status !== 'archived') add('inspection_not_completed');
  if (!i.completedAt) add('missing_completion_date');

  const errors = validateAnswers(input.template.content, input.answers, input.evaluation.state);
  for (const q of Object.keys(errors)) add('missing_or_invalid_answer', q);

  // stored flags must match what the template + answers produce now (detects tampering or data drift)
  const stored = new Set(input.flags.map((f) => f.questionId));
  const computed = new Set(input.evaluation.flags.map((f) => f.questionId));
  for (const q of computed) if (!stored.has(q)) add('flag_missing', q);
  for (const q of stored) if (!computed.has(q)) add('flag_unexpected', q);

  for (const [q, m] of Object.entries(input.media ?? {})) if (m.photos.length !== m.expected) add('missing_media', q);

  input.signatures.forEach((s, n) => {
    if (!s.name.trim() || Number.isNaN(Date.parse(s.signedAt))) add('invalid_signature', String(n));
  });
  return issues;
}
