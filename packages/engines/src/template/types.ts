// Template model. A template VERSION is plain JSON (stored as jsonb) and, once published, never changes.
// Everything here is configuration: nothing is hard-coded per question.

export type LocalizedText = { ar?: string; en?: string };

export const RESPONSE_TYPES = [
  'text', 'long_text', 'number', 'decimal', 'yes_no', 'yes_no_na', 'pass_fail_na', 'good_fair_poor_na', 'rating',
  'multiple_choice', 'multiple_select', 'checkbox', 'date', 'time', 'datetime', 'location', 'gps', 'signature',
  'photo', 'video', 'audio', 'file', 'asset_selector', 'user_selector', 'company_selector', 'site_selector',
  'department_selector', 'formula',
] as const;
export type ResponseType = (typeof RESPONSE_TYPES)[number];

export type Scalar = string | number | boolean;
export type Op = 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'not_empty' | 'contains';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { questionId: string; op: Op; value?: Scalar | Scalar[] };

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITY_ORDER: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export type FlagRule = {
  when: {
    answerIn?: string[];
    numberLt?: number; numberLte?: number; numberGt?: number; numberGte?: number;
    /** question score as % of its maximum is below this value (needs `scoring`) */
    scoreBelowPct?: number;
  };
  severity: Severity;
  description?: LocalizedText;
};

/** Present => the question takes part in scoring. `{}` means "use the defaults for its response type". */
export type Scoring = {
  /** option value -> points; `null` = Not Applicable (excluded from the score) */
  optionScores?: Record<string, number | null>;
  maxScore?: number;
  weight?: number;
};

export type Option = { value: string; label: LocalizedText };

export type Question = {
  kind: 'question';
  id: string;
  title: LocalizedText;
  description?: LocalizedText;
  helpText?: LocalizedText;
  responseType: ResponseType;
  required?: boolean;
  options?: Option[];          // multiple_choice / multiple_select
  ratingMax?: 5 | 10;          // rating
  min?: number; max?: number;  // number / decimal
  maxLength?: number;          // text / long_text
  formula?: string;            // formula: e.g. "{q1} * {q2} / 100"
  category?: string;           // for category scores
  scoring?: Scoring;
  flagRules?: FlagRule[];
  visibleWhen?: Condition;
  requiredWhen?: Condition;
  disabledWhen?: Condition;
  allowAttachments?: boolean; allowComments?: boolean; allowNotes?: boolean;
  assetRelation?: boolean;
};

export type TableColumn = { id: string; title: LocalizedText; responseType: ResponseType; required?: boolean };
export type Table = {
  kind: 'table';
  id: string;
  title: LocalizedText;
  columns: TableColumn[];
  repeating?: boolean;
  minRows?: number; maxRows?: number;
  visibleWhen?: Condition;
};

export type Section = {
  kind: 'section';
  id: string;
  title: LocalizedText;
  description?: LocalizedText;
  visibleWhen?: Condition;
  items: (Question | Table)[];
};

export type Page = {
  id: string;
  title: LocalizedText;
  description?: LocalizedText;
  visibleWhen?: Condition;
  items: (Section | Question | Table)[];
};

export type TemplateContent = { pages: Page[]; passThresholdPct?: number };

export type Answers = Record<string, unknown>;

export const PRESET_OPTIONS: Partial<Record<ResponseType, string[]>> = {
  yes_no: ['yes', 'no'],
  yes_no_na: ['yes', 'no', 'na'],
  pass_fail_na: ['pass', 'fail', 'na'],
  good_fair_poor_na: ['good', 'fair', 'poor', 'na'],
};

export const DEFAULT_OPTION_SCORES: Partial<Record<ResponseType, Record<string, number | null>>> = {
  yes_no: { yes: 100, no: 0 },
  yes_no_na: { yes: 100, no: 0, na: null },
  pass_fail_na: { pass: 100, fail: 0, na: null },
  good_fair_poor_na: { good: 100, fair: 50, poor: 0, na: null },
};

export const SCORABLE_TYPES: ResponseType[] = ['yes_no', 'yes_no_na', 'pass_fail_na', 'good_fair_poor_na', 'multiple_choice', 'rating'];

export function optionValues(q: Question): string[] {
  if (q.options) return q.options.map((o) => o.value);
  return PRESET_OPTIONS[q.responseType] ?? [];
}

export type QuestionCtx = { question: Question; pageId: string; sectionId: string | null };

export function forEachQuestion(content: TemplateContent, cb: (c: QuestionCtx) => void): void {
  for (const page of content.pages) {
    for (const item of page.items) {
      if (item.kind === 'question') cb({ question: item, pageId: page.id, sectionId: null });
      else if (item.kind === 'section') {
        for (const sub of item.items) if (sub.kind === 'question') cb({ question: sub, pageId: page.id, sectionId: item.id });
      }
    }
  }
}

export const localized = (t: LocalizedText | undefined, locale: 'ar' | 'en'): string =>
  (t?.[locale] || t?.[locale === 'ar' ? 'en' : 'ar'] || '').trim();
