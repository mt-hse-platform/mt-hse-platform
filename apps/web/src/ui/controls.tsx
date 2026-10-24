// One input control per response type. Values are plain JSON (strings, numbers, booleans, arrays, {lat,lng}).
import type { ReactNode } from 'react';
import { useT } from '../i18nReact.tsx';
import type { Question } from '../../../../packages/engines/src/template/types.ts';
import { localized, optionValues } from '../../../../packages/engines/src/template/types.ts';
import { labelOrRaw } from '../../../../packages/engines/src/report/labels.ts';
import type { ReportLocale } from '../../../../packages/engines/src/report/labels.ts';
import { AttachmentControl, SignatureControl } from './MediaControls.tsx';

type Props = {
  q: Question; value: unknown; disabled: boolean; locale: ReportLocale; onChange: (v: unknown) => void;
  /** needed by attachments and signatures (they are stored against the inspection) */
  inspectionId?: string; signerName?: string;
};

function Choices({ options, selected, multi, disabled, onPick }: {
  options: { value: string; label: string }[]; selected: string[]; multi: boolean; disabled: boolean; onPick: (v: string) => void;
}) {
  return (
    <div className="choice-row" role={multi ? 'group' : 'radiogroup'}>
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button key={o.value} type="button" disabled={disabled} className={`choice ${on ? 'selected' : ''}`}
            role={multi ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => onPick(o.value)}>
            {on ? '✓ ' : ''}{o.label}
          </button>
        );
      })}
    </div>
  );
}

export function QuestionControl({ q, value, disabled, locale, onChange, inspectionId, signerName }: Props): ReactNode {
  const t = useT();
  const str = typeof value === 'string' || typeof value === 'number' ? String(value) : '';

  switch (q.responseType) {
    case 'text':
      return <input className="input" type="text" maxLength={q.maxLength ?? 500} value={str} disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />;
    case 'long_text':
      return <textarea className="input" rows={4} maxLength={q.maxLength ?? 5000} value={str} disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />;
    case 'number':
    case 'decimal':
      return <input className="input" type="number" inputMode={q.responseType === 'number' ? 'numeric' : 'decimal'}
        step={q.responseType === 'number' ? 1 : 'any'} min={q.min} max={q.max} value={str} disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'yes_no': case 'yes_no_na': case 'pass_fail_na': case 'good_fair_poor_na':
      return <Choices multi={false} disabled={disabled} selected={typeof value === 'string' ? [value] : []}
        options={optionValues(q).map((v) => ({ value: v, label: labelOrRaw(locale, 'answer', v) }))}
        onPick={(v) => onChange(v === value ? null : v)} />;
    case 'rating':
      return <Choices multi={false} disabled={disabled} selected={value === null || value === undefined ? [] : [String(value)]}
        options={Array.from({ length: q.ratingMax ?? 5 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
        onPick={(v) => onChange(Number(v) === value ? null : Number(v))} />;
    case 'multiple_choice':
      return <Choices multi={false} disabled={disabled} selected={typeof value === 'string' ? [value] : []}
        options={(q.options ?? []).map((o) => ({ value: o.value, label: localized(o.label, locale) || o.value }))}
        onPick={(v) => onChange(v === value ? null : v)} />;
    case 'multiple_select': {
      const cur = Array.isArray(value) ? value.map(String) : [];
      return <Choices multi disabled={disabled} selected={cur}
        options={(q.options ?? []).map((o) => ({ value: o.value, label: localized(o.label, locale) || o.value }))}
        onPick={(v) => { const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]; onChange(next.length ? next : null); }} />;
    }
    case 'checkbox':
      return <Choices multi disabled={disabled} selected={value === true ? ['yes'] : []}
        options={[{ value: 'yes', label: labelOrRaw(locale, 'answer', 'true') }]}
        onPick={() => onChange(value === true ? false : true)} />;
    case 'date':
      return <input className="input" type="date" value={str} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />;
    case 'time':
      return <input className="input" type="time" value={str} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />;
    case 'datetime':
      return <input className="input" type="datetime-local" value={str} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} />;
    case 'gps':
    case 'location': {
      const g = value as { lat?: number; lng?: number } | null;
      const has = g && typeof g.lat === 'number' && typeof g.lng === 'number';
      return (
        <div className="stack">
          {has && <bdi>{g!.lat!.toFixed(5)}, {g!.lng!.toFixed(5)}</bdi>}
          <button type="button" className="btn" disabled={disabled}
            onClick={() => navigator.geolocation.getCurrentPosition(
              (p) => onChange({ lat: p.coords.latitude, lng: p.coords.longitude }),
              () => window.alert(t('runner.gpsError')))}>
            {t('runner.useGps')}
          </button>
        </div>
      );
    }
    case 'formula':
      return <div className="muted"><b>{str === '' ? '—' : <bdi>{str}</bdi>}</b> · {t('runner.computed')}</div>;
    case 'photo':
    case 'audio':
    case 'file':
      return inspectionId
        ? <AttachmentControl q={q} kind={q.responseType} value={value} disabled={disabled} inspectionId={inspectionId} onChange={onChange} />
        : <div className="notice notice-warning">{t('runner.unsupported')}</div>;
    case 'signature':
      return inspectionId
        ? <SignatureControl q={q} value={value} disabled={disabled} inspectionId={inspectionId} signerName={signerName ?? ''} onChange={onChange} />
        : <div className="notice notice-warning">{t('runner.unsupported')}</div>;
    default:
      return <div className="notice notice-warning">{t('runner.unsupported')}</div>;
  }
}
