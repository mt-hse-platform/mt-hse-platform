// Actions and Issues: list, detail (move through the workflow, edit, comment, history) and creation.
// The same screens serve both kinds; the permission and workflow rules come from the shared engines.
import { useEffect, useMemo, useState } from 'react';
import { endpoints } from '../platform.ts';
import { useLocale, useT } from '../i18nReact.tsx';
import { Badge, EmptyState, ErrorNotice, LoadingBlock, fmtDateTime } from './common.tsx';
import { useLoad } from './hooks.ts';
import type { Loaded } from './hooks.ts';
import { ApiError } from '../core/apiClient.ts';
import { ALL_STATUSES, PRIORITIES, TYPES, allowedTransitions, canAssign, canAssignAtCreate, canCreate, canEdit } from '../core/work.ts';
import type { SessionLike } from '../core/work.ts';
import type { CommentDto, PersonDto, WorkItemDto, WorkKind } from '../core/types.ts';
import type { WorkFilter } from '../core/router.ts';
import { labelOrRaw } from '../../../../packages/engines/src/report/labels.ts';
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';

const priorityTone = (p: string) => (p === 'critical' || p === 'high' ? 'danger' : p === 'medium' ? 'warning' : 'neutral') as 'danger' | 'warning' | 'neutral';
const statusTone = (s: string) => (s === 'overdue' ? 'danger' : s === 'completed' || s === 'closed' || s === 'resolved' ? 'success' : s === 'cancelled' || s === 'rejected' ? 'neutral' : 'info') as 'danger' | 'success' | 'neutral' | 'info';

function useStatusText() {
  const locale = useLocale();
  const t = useT();
  return (s: string) => (s === 'overdue' ? t('work.overdue') : labelOrRaw(locale, 'status', s));
}

function itemStatus(kind: WorkKind, i: WorkItemDto): string {
  return kind === 'action' ? i.effectiveStatus ?? i.status : i.overdue ? 'overdue' : i.status;
}

// ---------------------------------------------------------------- list

export function WorkListPage({ kind, filter, canCreateNew, onOpen, onNew, onFilter }: {
  kind: WorkKind; filter: WorkFilter; canCreateNew: boolean; onOpen: (id: string) => void; onNew: () => void; onFilter: (f: WorkFilter) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const statusText = useStatusText();
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<WorkItemDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  async function loadPage(cursor: string | undefined, replace: boolean) {
    setLoading(true);
    setError(null);
    try {
      const r = await endpoints.listWork(kind, { status: status || undefined, mine: filter === 'mine', overdue: filter === 'overdue', cursor, limit: 25 });
      setItems((prev) => (replace ? r.items : [...prev, ...r.items]));
      setNext(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void loadPage(undefined, true); }, [kind, status, filter]);

  const title = t(kind === 'action' ? 'nav.actions' : 'nav.issues');
  const newButton = canCreateNew ? <button className="btn btn-primary" onClick={onNew}>{t(kind === 'action' ? 'actions.new' : 'issues.new')}</button> : undefined;

  return (
    <section className="stack">
      <div className="row-between"><h1>{title}</h1>{newButton}</div>
      <div className="choice-row" role="group">
        <button className={`choice ${filter === null && status === '' ? 'selected' : ''}`} onClick={() => { setStatus(''); onFilter(null); }}>{t('work.all')}</button>
        <button className={`choice ${filter === 'mine' ? 'selected' : ''}`} onClick={() => onFilter('mine')}>{t('work.mine')}</button>
        <button className={`choice ${filter === 'overdue' ? 'selected' : ''}`} onClick={() => onFilter('overdue')}>{t('work.overdue')}</button>
        {ALL_STATUSES[kind].map((s) => (
          <button key={s} className={`choice ${status === s ? 'selected' : ''}`} onClick={() => setStatus(status === s ? '' : s)}>{labelOrRaw(locale, 'status', s)}</button>
        ))}
      </div>
      {error ? <ErrorNotice error={error} onRetry={() => void loadPage(undefined, true)} /> : null}
      {!loading && !error && items.length === 0 && (
        <EmptyState title={t(kind === 'action' ? 'actions.empty.title' : 'issues.empty.title')} description={t(kind === 'action' ? 'actions.empty.desc' : 'issues.empty.desc')} action={newButton} />
      )}
      <ul className="list">
        {items.map((i) => (
          <li key={i.id}>
            <button className="list-row" onClick={() => onOpen(i.id)}>
              <span className="list-main">
                <b><bdi>{i.title}</bdi></b>
                <span className="muted">{i.dueDate ? <bdi>{i.dueDate}</bdi> : '—'}</span>
              </span>
              <span className="list-side">
                <Badge tone={priorityTone(i.priority)}>{labelOrRaw(locale, 'priority', i.priority)}</Badge>
                <Badge tone={statusTone(itemStatus(kind, i))}>{statusText(itemStatus(kind, i))}</Badge>
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

// ---------------------------------------------------------------- detail

export function WorkDetailPage({ kind, id, session, onBack, onOpenInspection }: {
  kind: WorkKind; id: string; session: SessionLike; onBack: () => void; onOpenInspection: (id: string) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const statusText = useStatusText();
  const item = useLoad(() => endpoints.getWork(kind, id), [kind, id]);
  const history = useLoad(() => endpoints.workTimeline(kind, id), [kind, id]);
  const comments = useLoad(() => (kind === 'action' ? endpoints.listComments(id) : Promise.resolve({ items: [] })), [kind, id]);
  const people = useLoad(async () => { try { return (await endpoints.listPeople()).items; } catch { return [] as PersonDto[]; } }, []);
  const sites = useLoad(() => endpoints.listSites(), []);
  const [current, setCurrent] = useState<WorkItemDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => { if (item.data) setCurrent(item.data); }, [item.data]);

  const names = useMemo(() => new Map((people.data ?? []).map((p) => [p.userId, p.fullName])), [people.data]);
  const siteName = (sid: string | null) => (sid ? sites.data?.items.find((s) => s.id === sid)?.name ?? '—' : '—');
  const who = (uid: string | null) => (uid ? names.get(uid) ?? (uid === session.userId ? session.name ?? '—' : uid.slice(0, 8)) : t('work.unassigned'));

  if (item.loading && !current) return <LoadingBlock />;
  if (item.error || !current) return <ErrorNotice error={item.error} onRetry={item.reload} />;

  async function apply(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const updated = await endpoints.patchWork(kind, id, { version: current!.version, ...body });
      setCurrent(updated);
      history.reload();
      setEditing(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') { item.reload(); history.reload(); }
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const transitions = allowedTransitions(kind, session, current);
  const editable = canEdit(kind, session, current) || canAssign(kind, session, current);
  const shown = itemStatus(kind, current);

  return (
    <section className="stack">
      <div className="row-between">
        <button className="btn" onClick={onBack}>←</button>
        <h1 className="grow"><bdi>{current.title}</bdi></h1>
        <Badge tone={statusTone(shown)}>{statusText(shown)}</Badge>
      </div>

      <div className="card stack">
        {current.description && <p><bdi>{current.description}</bdi></p>}
        <dl className="facts">
          <dt>{t('work.type')}</dt><dd>{t(`type.${current.type}` as MessageKey)}</dd>
          <dt>{t('work.priority')}</dt><dd><Badge tone={priorityTone(current.priority)}>{labelOrRaw(locale, 'priority', current.priority)}</Badge></dd>
          <dt>{t('work.dueDate')}</dt><dd><bdi>{current.dueDate ?? '—'}</bdi></dd>
          <dt>{t('work.assignee')}</dt><dd><bdi>{who(current.assigneeId)}</bdi></dd>
          <dt>{t('work.site')}</dt><dd><bdi>{siteName(current.siteId)}</bdi></dd>
        </dl>
        {current.inspectionId && (
          <button className="link-btn" onClick={() => onOpenInspection(current.inspectionId!)}>{t('work.fromInspection')} — {t('work.openInspection')}</button>
        )}
      </div>

      {error ? <ErrorNotice error={error} /> : null}

      {transitions.length > 0 && (
        <div className="card stack">
          <b>{t('work.moveTo')}</b>
          <div className="choice-row">
            {transitions.map((to) => (
              <button key={to} className="btn btn-primary" disabled={busy} onClick={() => void apply({ status: to })}>{statusText(to)}</button>
            ))}
          </div>
        </div>
      )}

      {editable && !editing && <button className="btn" onClick={() => setEditing(true)}>{t('work.edit')}</button>}
      {editable && editing && (
        <EditForm kind={kind} item={current} people={people.data ?? []} canAssignNow={canAssign(kind, session, current)} canEditFields={canEdit(kind, session, current)}
          busy={busy} onCancel={() => setEditing(false)} onSave={(body) => void apply(body)} />
      )}

      {kind === 'action' && <Comments actionId={id} list={comments} names={names} />}

      <h2>{t('work.timeline')}</h2>
      {history.loading && !history.data && <LoadingBlock />}
      <ul className="list">
        {history.data?.items.map((e) => (
          <li key={e.id} className="card">
            <div className="row-between">
              <b>{t(`event.${e.event}` as MessageKey)}</b>
              <span className="muted"><bdi>{fmtDateTime(e.at)}</bdi></span>
            </div>
            <div className="muted"><bdi>{who(e.actorUserId)}</bdi>{describeChange(e, statusText, who)}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function describeChange(e: { event: string; field: string | null; oldValue: unknown; newValue: unknown }, statusText: (s: string) => string, who: (id: string | null) => string): string {
  if (e.event === 'status_changed') return ` · ${e.oldValue ? statusText(String(e.oldValue)) : '—'} → ${statusText(String(e.newValue))}`;
  if (e.event === 'assigned') return ` · ${who((e.oldValue as string | null) ?? null)} → ${who((e.newValue as string | null) ?? null)}`;
  if (e.event === 'priority_changed' || e.event === 'due_date_changed') return ` · ${String(e.oldValue ?? '—')} → ${String(e.newValue ?? '—')}`;
  return '';
}

function EditForm({ kind, item, people, canAssignNow, canEditFields, busy, onCancel, onSave }: {
  kind: WorkKind; item: WorkItemDto; people: PersonDto[]; canAssignNow: boolean; canEditFields: boolean; busy: boolean;
  onCancel: () => void; onSave: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description ?? '');
  const [priority, setPriority] = useState(item.priority);
  const [type, setType] = useState(item.type);
  const [dueDate, setDueDate] = useState(item.dueDate ?? '');
  const [assigneeId, setAssigneeId] = useState(item.assigneeId ?? '');

  function save() {
    const body: Record<string, unknown> = {};
    if (canEditFields) {
      if (title.trim() !== item.title) body.title = title.trim();
      if (description.trim() !== (item.description ?? '')) body.description = description.trim() === '' ? null : description.trim();
      if (priority !== item.priority) body.priority = priority;
      if (type !== item.type) body.type = type;
      if (dueDate !== (item.dueDate ?? '')) body.dueDate = dueDate === '' ? null : dueDate;
    }
    if (canAssignNow && assigneeId !== (item.assigneeId ?? '')) body.assigneeId = assigneeId === '' ? null : assigneeId;
    if (Object.keys(body).length === 0) { onCancel(); return; }
    onSave(body);
  }

  return (
    <div className="card stack">
      {canEditFields && (
        <>
          <label className="field"><span>{t('work.titleField')}</span><input type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
          <label className="field"><span>{t('work.description')}</span><textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
          <label className="field"><span>{t('work.type')}</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>{TYPES[kind].map((x) => <option key={x} value={x}>{t(`type.${x}` as MessageKey)}</option>)}</select></label>
          <label className="field"><span>{t('work.priority')}</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>{PRIORITIES.map((x) => <option key={x} value={x}>{labelOrRaw(locale, 'priority', x)}</option>)}</select></label>
          <label className="field"><span>{t('work.dueDate')}</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
        </>
      )}
      {canAssignNow && (
        <label className="field"><span>{t('work.assignee')}</span>
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
            <option value="">{t('work.unassigned')}</option>
            {people.map((p) => <option key={p.userId} value={p.userId}>{p.fullName}</option>)}
          </select></label>
      )}
      <div className="choice-row">
        <button className="btn btn-primary" disabled={busy} onClick={save}>{t('work.save')}</button>
        <button className="btn" disabled={busy} onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}

function Comments({ actionId, list, names }: { actionId: string; list: Loaded<{ items: CommentDto[] }>; names: Map<string, string> }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function add() {
    setBusy(true); setError(null);
    try { await endpoints.addComment(actionId, text.trim()); setText(''); list.reload(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div className="stack">
      <h2>{t('work.comments')}</h2>
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      <ul className="list">
        {list.data?.items.map((c) => (
          <li key={c.id} className="card stack">
            <div className="row-between"><b><bdi>{names.get(c.authorId) ?? c.authorId.slice(0, 8)}</bdi></b><span className="muted"><bdi>{fmtDateTime(c.createdAt)}</bdi></span></div>
            <div><bdi>{c.body}</bdi></div>
          </li>
        ))}
      </ul>
      <textarea className="input" rows={3} placeholder={t('work.commentPlaceholder')} value={text} onChange={(e) => setText(e.target.value)} />
      {error ? <ErrorNotice error={error} /> : null}
      <button className="btn btn-primary" disabled={busy || text.trim() === ''} onClick={() => void add()}>{t('work.addComment')}</button>
    </div>
  );
}

// ---------------------------------------------------------------- create

export function NewWorkPage({ kind, presetType, session, onCreated }: { kind: WorkKind; presetType: string | null; session: SessionLike; onCreated: (id: string) => void }) {
  const t = useT();
  const locale = useLocale();
  const sites = useLoad(() => endpoints.listSites(), []);
  const people = useLoad(async () => { try { return (await endpoints.listPeople()).items; } catch { return [] as PersonDto[]; } }, []);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState(presetType && TYPES[kind].includes(presetType) ? presetType : TYPES[kind][0]!);
  const [priority, setPriority] = useState('medium');
  const [siteId, setSiteId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!canCreate(kind, session)) return <ErrorNotice error={{ code: 'forbidden' }} />;
  const mayAssign = kind === 'action' ? session.grants.some((g) => g.permission === 'action.assign') : canAssignAtCreate(session);

  async function create() {
    setBusy(true); setError(null);
    const body: Record<string, unknown> = { title: title.trim(), type, priority };
    if (description.trim()) body.description = description.trim();
    if (siteId) body.siteId = siteId;
    if (dueDate) body.dueDate = dueDate;
    if (mayAssign && assigneeId) body.assigneeId = assigneeId;
    try { const created = await endpoints.createWork(kind, body); onCreated(created.id); } catch (e) { setError(e); setBusy(false); }
  }

  return (
    <section className="stack">
      <h1>{t(kind === 'action' ? 'actions.new' : 'issues.new')}</h1>
      <div className="card stack">
        <label className="field"><span>{t('work.titleField')}</span><input type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field"><span>{t('work.description')}</span><textarea className="input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="field"><span>{t('work.type')}</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>{TYPES[kind].map((x) => <option key={x} value={x}>{t(`type.${x}` as MessageKey)}</option>)}</select></label>
        <label className="field"><span>{t('work.priority')}</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>{PRIORITIES.map((x) => <option key={x} value={x}>{labelOrRaw(locale, 'priority', x)}</option>)}</select></label>
        {sites.data && sites.data.items.length > 0 && (
          <label className="field"><span>{t('work.site')}</span>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">{t('inspections.noSite')}</option>
              {sites.data.items.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
        )}
        <label className="field"><span>{t('work.dueDate')}</span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
        {mayAssign && (people.data?.length ?? 0) > 0 && (
          <label className="field"><span>{t('work.assignee')}</span>
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">{t('work.unassigned')}</option>
              {people.data!.map((p) => <option key={p.userId} value={p.userId}>{p.fullName}</option>)}
            </select></label>
        )}
        {error ? <ErrorNotice error={error} /> : null}
        <button className="btn btn-primary" disabled={busy || title.trim().length < 3} onClick={() => void create()}>{busy ? t('common.loading') : t('work.create')}</button>
      </div>
    </section>
  );
}
