// One Validation Engine, used by the UI and the API. Errors are codes + params (translated by the i18n package),
// never raw English strings.

export type FieldType =
  | 'text' | 'long_text' | 'number' | 'decimal' | 'date' | 'time' | 'datetime'
  | 'single_select' | 'multi_select' | 'file';

export type FileInfo = { name: string; mimeType: string; sizeBytes: number };

export type FieldRule = {
  type: FieldType;
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  minDate?: string; // YYYY-MM-DD
  maxDate?: string;
  options?: string[];
  maxSelections?: number;
  allowedMimeTypes?: string[];
  maxFileBytes?: number;
};

export type ValidationError = { code: string; params?: Record<string, string | number> };
export type FormResult = { ok: boolean; errors: Record<string, ValidationError[]> };

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateField(value: unknown, rule: FieldRule): ValidationError[] {
  if (isEmpty(value)) return rule.required ? [{ code: 'required' }] : [];
  const errors: ValidationError[] = [];

  switch (rule.type) {
    case 'text':
    case 'long_text': {
      if (typeof value !== 'string') return [{ code: 'invalid_type' }];
      if (rule.minLength !== undefined && value.length < rule.minLength) errors.push({ code: 'min_length', params: { min: rule.minLength } });
      if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push({ code: 'max_length', params: { max: rule.maxLength } });
      break;
    }
    case 'number':
    case 'decimal': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isFinite(n)) return [{ code: 'invalid_number' }];
      if (rule.type === 'number' && !Number.isInteger(n)) errors.push({ code: 'not_integer' });
      if (rule.min !== undefined && n < rule.min) errors.push({ code: 'min', params: { min: rule.min } });
      if (rule.max !== undefined && n > rule.max) errors.push({ code: 'max', params: { max: rule.max } });
      break;
    }
    case 'date': {
      if (typeof value !== 'string' || !isValidDate(value)) return [{ code: 'invalid_date' }];
      if (rule.minDate && value < rule.minDate) errors.push({ code: 'date_before_min', params: { min: rule.minDate } });
      if (rule.maxDate && value > rule.maxDate) errors.push({ code: 'date_after_max', params: { max: rule.maxDate } });
      break;
    }
    case 'time': {
      if (typeof value !== 'string' || !TIME_RE.test(value)) return [{ code: 'invalid_time' }];
      break;
    }
    case 'datetime': {
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return [{ code: 'invalid_datetime' }];
      break;
    }
    case 'single_select': {
      if (typeof value !== 'string') return [{ code: 'invalid_type' }];
      if (rule.options && !rule.options.includes(value)) errors.push({ code: 'invalid_option' });
      break;
    }
    case 'multi_select': {
      if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) return [{ code: 'invalid_type' }];
      if (rule.options && value.some((x) => !rule.options!.includes(x))) errors.push({ code: 'invalid_option' });
      if (rule.maxSelections !== undefined && value.length > rule.maxSelections) errors.push({ code: 'too_many_selections', params: { max: rule.maxSelections } });
      break;
    }
    case 'file': {
      const f = value as Partial<FileInfo>;
      if (typeof f !== 'object' || typeof f.mimeType !== 'string' || typeof f.sizeBytes !== 'number') return [{ code: 'invalid_type' }];
      if (rule.allowedMimeTypes && !rule.allowedMimeTypes.includes(f.mimeType)) errors.push({ code: 'file_type' });
      if (rule.maxFileBytes !== undefined && f.sizeBytes > rule.maxFileBytes) {
        errors.push({ code: 'file_too_large', params: { maxMb: Math.round((rule.maxFileBytes / 1048576) * 10) / 10 } });
      }
      break;
    }
  }
  return errors;
}

/** Validates a set of fields. Fields reported invisible by `isVisible` (conditional logic) are skipped entirely. */
export function validateForm(
  values: Record<string, unknown>,
  rules: Record<string, FieldRule>,
  isVisible: (fieldKey: string) => boolean = () => true,
): FormResult {
  const errors: Record<string, ValidationError[]> = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (!isVisible(key)) continue;
    const e = validateField(values[key], rule);
    if (e.length > 0) errors[key] = e;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}
