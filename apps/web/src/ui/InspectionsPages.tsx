import { useEffect, useState } from 'react';
import { endpoints, offlineReady, offlineStarts, templateCache } from '../platform.ts';
import { ApiError } from '../core/apiClient.ts';
import { useT, useLocale } from '../i18nReact.tsx';
import { Badge, EmptyState, ErrorNotice, LoadingBlock, fmtDateTime } from './common.tsx';
import { useLoad } from './hooks.ts';
import type { InspectionDto, InspectionStatus, SiteDto } from '../core/types.ts';
import { localized } from '../../../../packages/engines/src/template/types.ts';
import type { LocalizedText } from '../../../../packages/engines/src/template/types.ts';
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';

const STATUSES: InspectionStatus[] = ['in_progress', 'completed', 'cancelled', 'archived'];
const TONE: Record<InspectionStatus, 'info' | 'success' | 'warning' | 'neutral'> = {
  in_progress: 'info', completed: 'success', cancelled: 'warning', archived: 'neutral',
};

export function InspectionsPage({ canStart, onOpen, onStart }: { canStart: boolean; onOpen: (id: string) => void; onStart: () => void }) {
  const t = useT();
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<InspectionDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  async function loadPage(cursor: string | undefined, replace: boolean) {
    setLoading(true);
    setError(null);
    try {
      const r = await endpoints.listInspections({ status: status || undefined, cursor, limit: 25 });
      setItems((prev) => (replace ? r.items : [...prev, ...r.items]));
      setNext(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void loadPage(undefined, true); }, [status]);

  const start = canStart ? <button className="btn btn-primary" onClick={onStart}>{t('inspections.start')}</button> : undefined;

  return (
    <section className="stack">
      <div className="row-between">
        <h1>{t('inspections.title')}</h1>
        {start}
      </div>
      <div className="choice-row" role="group">
        {['', ...STATUSES].map((s) => (
          <button key={s || 'all'} className={`choice ${status === s ? 'selected' : ''}`} onClick={() => setStatus(s)}>
            {s === '' ? t('inspections.filterAll') : t(`inspection.status.${s}` as MessageKey)}
          </button>
        ))}
      </div>
      {error ? <ErrorNotice error={error} onRetry={() => void loadPage(undefined, true)} /> : null}
      {!loading && !error && items.length === 0 && (
        <EmptyState title={t('inspections.empty.title')} description={t('inspections.empty.desc')} action={start} />
      )}
      <ul className="list">
        {items.map((i) => (
          <li key={i.id}>
            <button className="list-row" onClick={() => onOpen(i.id)}>
              <span className="list-main">
                <b><bdi>{i.title || i.id.slice(0, 8).toUpperCase()}</bdi></b>
                <span className="muted"><bdi>{fmtDateTime(i.startedAt)}</bdi></span>
              </span>
              <span className="list-side">
                {i.scorePct !== null && <bdi>{i.scorePct}%</bdi>}
                <Badge tone={TONE[i.status]}>{t(`inspection.status.${i.status}` as MessageKey)}</Badge>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {loading && <LoadingBlock />}
      {next && !loading && <button className="btn" onClick={() => void loadPage(next, false)}>{t('inspections.loadMore')}</button>}
    </section>
  );
}

type Startable = { id: string; name: LocalizedText; category: string | null; versionId: string | null };

/** The templates and sites to choose from: the server's when online, the copies on the device otherwise. */
async function loadStartable(): Promise<{ items: Startable[]; sites: SiteDto[]; offline: boolean }> {
  await offlineReady();
  try {
    const [tpls, sites] = await Promise.all([endpoints.listTemplates({ status: 'published', limit: 100 }), endpoints.listSites().catch(() => null)]);
    void templateCache.refresh(offlineStarts.list().map((d) => d.templateVersionId));
    return {
      items: tpls.items.map((tp) => ({ id: tp.id, name: tp.name, category: tp.category, versionId: tp.publishedVersionId })),
      sites: sites ? sites.items : templateCache.sites(), offline: false,
    };
  } catch (e) {
    const refused = e instanceof ApiError && e.status < 500 && e.status !== 408 && e.status !== 429;   // a real "no" is shown, not hidden
    const cached = templateCache.list();
    if (refused || cached.length === 0) throw e;
    return { items: cached.map((c) => ({ id: c.id, name: c.name, category: null, versionId: c.versionId })), sites: templateCache.sites(), offline: true };
  }
}

export function NewInspectionPage({ onStarted, userId }: { onStarted: (id: string) => void; userId: string }) {
  const t = useT();
  const locale = useLocale();
  const startable = useLoad(() => loadStartable(), []);
  const [siteId, setSiteId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notDownloaded, setNotDownloaded] = useState(false);

  async function begin(tpl: Startable) {
    setBusy(tpl.id);
    setError(null);
    setNotDownloaded(false);
    try {
      if (!tpl.versionId) throw new ApiError(422, 'no_published_version');
      if (!(await templateCache.ensure(tpl.id, tpl.versionId))) { setNotDownloaded(true); setBusy(null); return; }   // needed to work offline
      // remembered on the device first; sent now when online, later when not
      const draft = await offlineStarts.create({ templateId: tpl.id, templateVersionId: tpl.versionId, siteId: siteId || null, title, startedBy: userId });
      const made = await offlineStarts.ensureCreated(draft.id);
      if (made.kind === 'rejected') { await offlineStarts.discard(draft.id); throw new ApiError(422, made.code); }
      onStarted(draft.id);
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  }

  const data = startable.data;
  return (
    <section className="stack">
      <h1>{t('inspections.pickTemplate')}</h1>
      {data?.offline && <div className="notice notice-warning" role="status">⚠ {t('inspections.offlineList')}</div>}
      <div className="card stack">
        {data && data.sites.length > 0 && (
          <label className="field">
            <span>{t('inspections.site')}</span>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">{t('inspections.noSite')}</option>
              {data.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t('inspections.titleOptional')}</span>
          <input type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {notDownloaded && <div className="notice notice-warning" role="alert">⚠ {t('inspections.notDownloaded')}</div>}
      {startable.error ? <ErrorNotice error={startable.error} onRetry={startable.reload} /> : null}
      {startable.loading && !data && <LoadingBlock />}
      {data && data.items.length === 0 && (
        <EmptyState title={t('inspections.noTemplates.title')} description={t('inspections.noTemplates.desc')} />
      )}
      <ul className="list">
        {data?.items.map((tpl) => (
          <li key={tpl.id}>
            <div className="list-row">
              <span className="list-main">
                <b><bdi>{localized(tpl.name, locale)}</bdi></b>
                {tpl.category && <span className="muted"><bdi>{tpl.category}</bdi></span>}
              </span>
              <button className="btn btn-primary" disabled={busy !== null} onClick={() => void begin(tpl)}>
                {busy === tpl.id ? t('common.loading') : t('inspections.begin')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
