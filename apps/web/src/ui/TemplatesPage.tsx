// Templates: list, and (for people with the right permissions) import a template from JSON, check it and publish it.
import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { endpoints } from '../platform.ts';
import { useLocale, useT } from '../i18nReact.tsx';
import { Badge, EmptyState, ErrorNotice, LoadingBlock } from './common.tsx';
import { useLoad } from './hooks.ts';
import { ApiError } from '../core/apiClient.ts';
import type { TemplateDto, TemplateIssueDto } from '../core/types.ts';
import { localized } from '../../../../packages/engines/src/template/types.ts';
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';

const TONE: Record<TemplateDto['status'], 'success' | 'info' | 'neutral'> = { published: 'success', draft: 'info', archived: 'neutral' };

export function TemplatesPage({ canImport, canPublish }: { canImport: boolean; canPublish: boolean }) {
  const t = useT();
  const locale = useLocale();
  const list = useLoad(() => endpoints.listTemplates({ limit: 100 }), []);
  const [showImport, setShowImport] = useState(false);

  return (
    <section className="stack">
      <div className="row-between">
        <h1>{t('templates.title')}</h1>
        {canImport && <button className="btn btn-primary" onClick={() => setShowImport((v) => !v)}>{t('templates.import')}</button>}
      </div>
      {showImport && canImport && <ImportForm onCreated={() => { setShowImport(false); list.reload(); }} />}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data && <LoadingBlock />}
      {list.data && list.data.items.length === 0 && (
        <EmptyState title={t('templates.empty.title')} description={t('templates.empty.desc')} />
      )}
      <ul className="list">
        {list.data?.items.map((tpl) => (
          <li key={tpl.id} className="card stack">
            <div className="row-between">
              <b><bdi>{localized(tpl.name, locale) || tpl.id}</bdi></b>
              <Badge tone={TONE[tpl.status]}>{t(`templates.${tpl.status}` as MessageKey)}</Badge>
            </div>
            {tpl.category && <div className="muted"><bdi>{tpl.category}</bdi></div>}
            {tpl.status === 'draft' && canPublish && <DraftActions templateId={tpl.id} onPublished={list.reload} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ImportForm({ onCreated }: { onCreated: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jsonError, setJsonError] = useState(false);

  async function readFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setText(await f.text());
  }

  async function create() {
    setError(null);
    setJsonError(false);
    let content: unknown;
    try { content = JSON.parse(text); } catch { setJsonError(true); return; }
    setBusy(true);
    try {
      await endpoints.importTemplate({ name: { [locale]: name.trim() }, content });
      onCreated();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <p className="muted">{t('templates.importHint')}</p>
      <label className="field">
        <span>{t('templates.name')}</span>
        <input type="text" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>{t('templates.chooseFile')}</span>
        <input type="file" accept="application/json,.json" onChange={(e) => void readFile(e)} />
      </label>
      <textarea className="input mono" dir="ltr" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
      {jsonError && <div className="error-text" role="alert">⚠ {t('templates.invalidJson')}</div>}
      {error ? <ErrorNotice error={error} /> : null}
      <button className="btn btn-primary" disabled={busy || !name.trim() || !text.trim()} onClick={() => void create()}>
        {busy ? t('common.loading') : t('templates.create')}
      </button>
    </div>
  );
}

function IssueList({ issues }: { issues: TemplateIssueDto[] }) {
  const t = useT();
  return (
    <div className="notice notice-danger" role="alert">
      <div className="stack">
        <b>{t('templates.problems')}</b>
        <ul dir="ltr" className="mono">
          {issues.map((i, n) => <li key={n}>{i.code}{i.path ? ` — ${i.path}` : ''}{i.detail ? ` (${i.detail})` : ''}</li>)}
        </ul>
      </div>
    </div>
  );
}

function DraftActions({ templateId, onPublished }: { templateId: string; onPublished: () => void }) {
  const t = useT();
  const [issues, setIssues] = useState<TemplateIssueDto[] | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function check() {
    setBusy(true); setError(null); setOk(false);
    try { const r = await endpoints.validateTemplate(templateId); setIssues(r.issues); setOk(r.valid); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }

  async function publish() {
    setBusy(true); setError(null); setOk(false);
    try {
      const d = await endpoints.getTemplate(templateId);
      const draft = d.versions.find((v) => v.status === 'draft');
      if (!draft) { setError({ code: 'not_found' }); return; }
      await endpoints.publishTemplate(templateId, draft.version);
      onPublished();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'template_invalid' && Array.isArray(e.details)) setIssues(e.details as TemplateIssueDto[]);
      else setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="choice-row">
        <button className="btn" disabled={busy} onClick={() => void check()}>{t('templates.check')}</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void publish()}>{t('templates.publish')}</button>
      </div>
      {ok && <div className="notice notice-success">✓ {t('templates.noProblems')}</div>}
      {issues && issues.length > 0 && <IssueList issues={issues} />}
      {error ? <ErrorNotice error={error} /> : null}
    </div>
  );
}
