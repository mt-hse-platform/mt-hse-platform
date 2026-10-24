// The inspection screen: one card per question, autosave with an offline outbox, conflict resolution, completion.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { discardLocalDraft, endpoints, ensuringSyncApi, localStore, offlineReady, offlineStarts, photoQueue, templateCache } from '../platform.ts';
import { ApiError, NetworkError } from '../core/apiClient.ts';
import { useLocale, useT } from '../i18nReact.tsx';
import { InspectionSync } from '../core/inspectionSync.ts';
import { stripLocalIds } from '../core/photoQueue.ts';
import { idsOf, withId } from '../core/media.ts';
import type { SyncStatus } from '../core/inspectionSync.ts';
import { buildRunner, collectValues, firstProblem, pageNav } from '../core/runner.ts';
import type { QuestionVM } from '../core/runner.ts';
import type { FlagDto, InspectionDto } from '../core/types.ts';
import { Badge, ErrorNotice, LoadingBlock } from './common.tsx';
import { QuestionControl } from './controls.tsx';
import { useLoad } from './hooks.ts';
import { translateValidation } from '../i18nReact.tsx';
import { answerText } from '../../../../packages/engines/src/report/model.ts';
import { forEachQuestion, localized } from '../../../../packages/engines/src/template/types.ts';
import type { Question, TemplateContent } from '../../../../packages/engines/src/template/types.ts';
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';

const STATUS_KEY: Record<SyncStatus, MessageKey> = {
  saved: 'sync.saved', saving: 'sync.saving', offline: 'sync.offline', conflict: 'sync.conflict', auth: 'sync.auth', locked: 'sync.locked',
};
const STATUS_TONE: Record<SyncStatus, 'success' | 'info' | 'warning' | 'danger'> = {
  saved: 'success', saving: 'info', offline: 'warning', conflict: 'danger', auth: 'danger', locked: 'warning',
};

type Loaded = {
  inspection: InspectionDto;
  content: TemplateContent;
  responses: Record<string, { value: unknown; version: number }>;
};

async function loadAll(id: string): Promise<Loaded> {
  await offlineReady();
  const draft = offlineStarts.get(id);
  if (draft) {
    // started on this device: try to make it real on the server first (online = a normal inspection from here on)
    const made = await offlineStarts.ensureCreated(id);
    if (made.kind === 'rejected') throw new ApiError(422, made.code);
    if (made.kind === 'auth') throw new ApiError(401, 'unauthenticated');
    if (made.kind === 'offline') {
      const content = templateCache.getContent(draft.templateVersionId);
      if (!content) throw new NetworkError();
      return { inspection: offlineStarts.toInspection(draft), content, responses: {} };
    }
  }
  const d = await endpoints.getInspection(id);
  const v = await endpoints.getVersion(d.inspection.templateId, d.inspection.templateVersionId);
  return { inspection: d.inspection, content: v.version.content, responses: d.responses };
}

export function InspectionPage({ id, signerName, onReport, onBack }: { id: string; signerName: string; onReport: (id: string) => void; onBack: () => void }) {
  const t = useT();
  const loaded = useLoad(() => loadAll(id), [id]);
  if (loaded.loading && !loaded.data) return <LoadingBlock />;
  if (loaded.error || !loaded.data) return <ErrorNotice error={loaded.error} onRetry={loaded.reload} />;
  const { inspection } = loaded.data;
  if (inspection.status !== 'in_progress') {
    return <FinishedView data={loaded.data} onReport={onReport} onBack={onBack} />;
  }
  return <Runner data={loaded.data} signerName={signerName} onFinished={loaded.reload} onBack={onBack} title={inspection.title ?? t('inspections.title')} />;
}

function Runner({ data, signerName, onFinished, onBack, title }: { data: Loaded; signerName: string; onFinished: () => void; onBack: () => void; title: string }) {
  const t = useT();
  const locale = useLocale();
  const { inspection, content } = data;
  const [, force] = useState(0);
  const [ready, setReady] = useState(false);
  const [pageId, setPageId] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [photosBlock, setPhotosBlock] = useState(false);
  const syncRef = useRef<InspectionSync | null>(null);

  useEffect(() => {
    const sync = new InspectionSync({
      inspectionId: inspection.id, api: ensuringSyncApi, store: localStore,
      onChange: () => force((n) => n + 1),
      onAuthError: () => force((n) => n + 1),
    });
    syncRef.current = sync;
    let alive = true;
    let detach: (() => void) | null = null;
    const offQueue = photoQueue.subscribe(() => force((n) => n + 1));   // thumbnails, counters and the completion check follow the queue
    const offStarts = offlineStarts.subscribe(() => force((n) => n + 1)); // the start of this inspection may be refused by the server
    void sync.init(data.responses).then(() => {
      if (!alive) return;
      setReady(true);
      // Files that finished uploading become part of the answer here (through the normal autosave outbox).
      detach = photoQueue.attach(inspection.id, async (item) => {
        if (sync.getStatus() === 'locked') return false;
        await sync.setAnswer(item.questionId, withId(stripLocalIds(sync.getValue(item.questionId)), item.mediaId));
        return true;
      });
    });
    const online = () => sync.notifyOnline();
    window.addEventListener('online', online);
    return () => {
      alive = false; offQueue(); offStarts(); detach?.();
      window.removeEventListener('online', online); sync.dispose(); syncRef.current = null;
    };
  }, [inspection.id]);

  const sync = syncRef.current;
  // cheap enough to recompute on every render (the sync object changes in place and triggers a render on each change)
  const waiting = photoQueue.list(inspection.id);
  const startFailed = offlineStarts.get(inspection.id)?.failedCode ?? null;   // the server refused to create this inspection
  const valueOf = (qid: string): unknown => {
    const base = sync ? sync.getValue(qid) : null;
    const mine = waiting.filter((w) => w.questionId === qid);
    return mine.length ? [...idsOf(base), ...mine.map((w) => w.id)] : base;
  };
  const vm = sync && ready ? buildRunner(content, collectValues(content, valueOf)) : null;
  const titles = useMemo(() => {
    const m = new Map<string, Question>();
    forEachQuestion(content, ({ question }) => m.set(question.id, question));
    return m;
  }, [content]);

  const answer = useCallback((qid: string, v: unknown) => { void syncRef.current?.setAnswer(qid, stripLocalIds(v)); }, []);
  const clearAnswer = useCallback((qid: string) => {
    void photoQueue.discardQuestion(inspection.id, qid);     // "clear" also drops files still waiting on the device
    void syncRef.current?.setAnswer(qid, null);
  }, [inspection.id]);

  if (!sync || !vm) return <LoadingBlock />;
  const current = vm.pages.find((p) => p.id === pageId) ?? vm.pages[0];
  if (!current) return <ErrorNotice error={{ code: 'not_found' }} />;
  const nav = pageNav(vm, current.id);
  const status = sync.getStatus();
  const conflicts = sync.conflicts();
  const done = vm.progress.answered;
  const pct = vm.progress.total ? Math.round((done / vm.progress.total) * 100) : 0;

  async function complete() {
    setError(null);
    setPhotosBlock(false);
    if (photoQueue.unfinishedCount(inspection.id) > 0) {
      setBusy(true);
      try { await photoQueue.drain(); } finally { setBusy(false); }
      if (photoQueue.unfinishedCount(inspection.id) > 0) { setPhotosBlock(true); return; }
    }
    if (!vm!.ready) {
      setShowErrors(true);
      const p = firstProblem(vm!);
      if (p) setPageId(p.pageId);
      return;
    }
    setBusy(true);
    try {
      const made = await offlineStarts.ensureCreated(inspection.id);   // an inspection started offline must exist on the server first
      if (made.kind === 'offline') { setError({ code: 'network' }); return; }
      if (made.kind === 'auth') { setError(new ApiError(401, 'unauthenticated')); return; }
      if (made.kind === 'rejected') { setError(new ApiError(422, made.code)); return; }
      await sync!.flush();
      if (sync!.getStatus() !== 'saved') { setError({ code: 'network' }); return; }
      await endpoints.completeInspection(inspection.id);
      onFinished();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!window.confirm(t('runner.cancelConfirm'))) return;
    setBusy(true);
    try {
      if (offlineStarts.get(inspection.id)) { await discardLocalDraft(inspection.id); onBack(); return; }   // never reached the server: nothing to cancel there
      await endpoints.cancelInspection(inspection.id);
      onFinished();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  const questionsOf = (q: QuestionVM) => (
    <QuestionCard key={q.id} vm={q} locale={locale} showErrors={showErrors} inspectionId={inspection.id} signerName={signerName}
      hasConflict={q.id in conflicts} onChange={(v) => answer(q.id, v)} onClear={() => clearAnswer(q.id)} />
  );

  return (
    <section className="stack runner">
      <div className="row-between">
        <button className="btn" onClick={onBack}>←</button>
        <h1 className="grow"><bdi>{title}</bdi></h1>
        <Badge tone={STATUS_TONE[status]}>{t(STATUS_KEY[status])}</Badge>
      </div>

      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="row-between muted">
        <span>{t('runner.page', { n: nav.index + 1, total: nav.total })}</span>
        <span>{t('runner.progress', { done, total: vm.progress.total })}</span>
      </div>
      <h2><bdi>{localized(current.title, locale)}</bdi></h2>

      {current.sections.map((s) => (
        <div key={s.id ?? 'loose'} className="stack">
          {s.title && <h3><bdi>{localized(s.title, locale)}</bdi></h3>}
          {s.questions.map(questionsOf)}
        </div>
      ))}

      {error ? <ErrorNotice error={error} /> : null}
      {waiting.length > 0 && (
        <div className="notice notice-info" role="status">⏳ {t('media.queuePending', { n: waiting.length })}</div>
      )}
      {photosBlock && <div className="notice notice-danger" role="alert">⚠ {t('media.queueBlock')}</div>}
      {startFailed && (
        <div className="notice notice-danger" role="alert">
          ⚠ {t('runner.startFailed')}
          <ErrorNotice error={new ApiError(422, startFailed)} />
        </div>
      )}
      {showErrors && !vm.ready && (
        <div className="notice notice-danger" role="alert">
          <span>⚠ {t('runner.missing')}</span>
          <button className="btn" onClick={() => { const p = firstProblem(vm); if (p) setPageId(p.pageId); }}>{t('runner.goToFirst')}</button>
        </div>
      )}

      <div className="page-actions">
        <button className="btn" disabled={!nav.prev} onClick={() => { setPageId(nav.prev); window.scrollTo(0, 0); }}>{t('runner.back')}</button>
        {nav.next
          ? <button className="btn btn-primary" onClick={() => { setPageId(nav.next); window.scrollTo(0, 0); }}>{t('runner.next')}</button>
          : <button className="btn btn-primary" disabled={busy || status === 'locked'} onClick={() => void complete()}>{t('runner.complete')}</button>}
      </div>
      <button className="btn btn-danger" disabled={busy} onClick={() => void cancel()}>{t('runner.cancel')}</button>

      {Object.keys(conflicts).length > 0 && (
        <div className="sheet-backdrop">
          <div className="sheet" role="dialog" aria-modal="true">
            <h3>{t('conflict.title')}</h3>
            {Object.entries(conflicts).map(([qid, c]) => {
              const q = titles.get(qid);
              return (
                <div key={qid} className="card stack">
                  <b><bdi>{q ? localized(q.title, locale) : qid}</bdi></b>
                  <div>{t('conflict.yours')}: <bdi>{q ? answerText(q, c.local, locale) : String(c.local)}</bdi></div>
                  <div>{t('conflict.other')}: <bdi>{q ? answerText(q, c.server?.value ?? null, locale) : String(c.server?.value ?? '')}</bdi></div>
                  <div className="choice-row">
                    <button className="btn btn-primary" onClick={() => void sync.resolveConflict(qid, 'keep_local')}>{t('conflict.mine')}</button>
                    <button className="btn" onClick={() => void sync.resolveConflict(qid, 'keep_server')}>{t('conflict.theirs')}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function QuestionCard({ vm, locale, showErrors, hasConflict, inspectionId, signerName, onChange, onClear }: {
  vm: QuestionVM; locale: 'ar' | 'en'; showErrors: boolean; hasConflict: boolean; inspectionId: string; signerName: string; onChange: (v: unknown) => void; onClear: () => void;
}) {
  const t = useT();
  const q = vm.question;
  const errs = showErrors ? vm.errors : [];
  return (
    <div className={`card qcard ${errs.length ? 'qcard-error' : ''} ${hasConflict ? 'qcard-conflict' : ''}`}>
      <div className="qtitle">
        <b><bdi>{localized(q.title, locale)}</bdi></b>
        {vm.required && <span className="muted"> · {t('runner.required')}</span>}
      </div>
      {q.helpText && <div className="muted"><bdi>{localized(q.helpText, locale)}</bdi></div>}
      <QuestionControl q={q} value={vm.value} disabled={vm.disabled} locale={locale} onChange={onChange} inspectionId={inspectionId} signerName={signerName} />
      {vm.answered && !vm.computed && !vm.disabled && (
        <button className="link-btn" onClick={onClear}>{t('runner.clear')}</button>
      )}
      {errs.map((e, i) => <div key={i} className="error-text" role="alert">⚠ {translateValidation(locale, e)}</div>)}
    </div>
  );
}

function FinishedView({ data, onReport, onBack }: { data: Loaded; onReport: (id: string) => void; onBack: () => void }) {
  const t = useT();
  const locale = useLocale();
  const { inspection, content } = data;
  const flags = useLoad(() => endpoints.listFlags(inspection.id), [inspection.id]);
  const [linked, setLinked] = useState<Record<string, { action?: boolean; issue?: boolean }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const titleOf = useMemo(() => {
    const m = new Map<string, string>();
    forEachQuestion(content, ({ question }) => m.set(question.id, localized(question.title, locale) || question.id));
    return m;
  }, [content, locale]);

  async function create(flag: FlagDto, kind: 'action' | 'issue') {
    setBusy(`${flag.id}:${kind}`);
    setError(null);
    try {
      await endpoints.fromFlag(inspection.id, flag.id, kind);
      setLinked((l) => ({ ...l, [flag.id]: { ...l[flag.id], [kind]: true } }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="stack">
      <div className="row-between">
        <button className="btn" onClick={onBack}>←</button>
        <h1 className="grow"><bdi>{inspection.title ?? t('runner.completed')}</bdi></h1>
        <Badge tone={inspection.status === 'completed' ? 'success' : 'warning'}>{t(`inspection.status.${inspection.status}` as MessageKey)}</Badge>
      </div>
      {inspection.status === 'completed' && (
        <div className="card stack">
          <div>{t('runner.score')}: <b><bdi>{inspection.scorePct === null ? '—' : `${inspection.scorePct}%`}</bdi></b></div>
          {inspection.passed !== null && <Badge tone={inspection.passed ? 'success' : 'danger'}>{inspection.passed ? t('runner.passed') : t('runner.failed')}</Badge>}
          <button className="btn btn-primary" onClick={() => onReport(inspection.id)}>{t('runner.viewReport')}</button>
        </div>
      )}
      <h2>{t('runner.flagged')}</h2>
      {error ? <ErrorNotice error={error} /> : null}
      {flags.loading && <LoadingBlock />}
      {flags.error ? <ErrorNotice error={flags.error} onRetry={flags.reload} /> : null}
      {flags.data && flags.data.items.length === 0 && <div className="muted">{t('runner.noFlags')}</div>}
      <ul className="list">
        {flags.data?.items.map((f) => {
          const hasAction = !!f.actionId || linked[f.id]?.action;
          const hasIssue = !!f.issueId || linked[f.id]?.issue;
          return (
            <li key={f.id} className="card stack">
              <div className="row-between">
                <b><bdi>{titleOf.get(f.questionId) ?? f.questionId}</bdi></b>
                <Badge tone={f.severity === 'low' ? 'success' : f.severity === 'medium' ? 'warning' : 'danger'}>{f.severity}</Badge>
              </div>
              <div className="choice-row">
                {hasAction ? <Badge tone="success">✓ {t('runner.createAction')}</Badge>
                  : <button className="btn" disabled={busy !== null} onClick={() => void create(f, 'action')}>{t('runner.createAction')}</button>}
                {hasIssue ? <Badge tone="success">✓ {t('runner.createIssue')}</Badge>
                  : <button className="btn" disabled={busy !== null} onClick={() => void create(f, 'issue')}>{t('runner.createIssue')}</button>}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
