// Home-screen card: my unfinished inspections, to continue or cancel. Hidden when there is nothing to show or the
// list cannot be loaded (offline): the inspections screen is still there.
import { useEffect, useState } from 'react';
import { discardLocalDraft, endpoints, localStore, offlineReady, offlineStarts, photoQueue } from '../platform.ts';
import { useT } from '../i18nReact.tsx';
import { pendingStoreKey } from '../core/inspectionSync.ts';
import { pickResumable } from '../core/resume.ts';
import type { InspectionDto } from '../core/types.ts';
import { ErrorNotice, fmtDateTime } from './common.tsx';

export function ResumeCard({ userId, onOpen }: { userId: string; onOpen: (id: string) => void }) {
  const t = useT();
  const [serverItems, setServerItems] = useState<InspectionDto[]>([]);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [, force] = useState(0);

  useEffect(() => photoQueue.subscribe(() => force((n) => n + 1)), []);
  useEffect(() => offlineStarts.subscribe(() => force((n) => n + 1)), []);
  useEffect(() => {
    let alive = true;
    void offlineReady().then(() => { if (alive) setStarted(true); });
    endpoints.listInspections({ status: 'in_progress', limit: 50 }).then(
      (r) => { if (alive) setServerItems(r.items); },
      () => undefined,
    );
    return () => { alive = false; };
  }, [userId]);

  // inspections started on this device that the server does not know yet, plus the server's list (server wins on a repeat)
  const drafts = started ? offlineStarts.list().map((d) => offlineStarts.toInspection(d)) : [];
  const known = new Set(serverItems.map((i) => i.id));
  const items = pickResumable([...serverItems, ...drafts.filter((d) => !known.has(d.id))], userId);

  async function discard(id: string) {
    if (!window.confirm(t('resume.discardConfirm'))) return;
    setBusy(id);
    setError(null);
    try {
      if (offlineStarts.get(id)) {
        await discardLocalDraft(id);                       // only on this device: nothing to cancel on the server
      } else {
        await endpoints.cancelInspection(id);
        await photoQueue.discardInspection(id);
        await localStore.remove(pendingStoreKey(id));
        setServerItems((prev) => prev.filter((i) => i.id !== id));
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0 && !error) return null;
  return (
    <div className="card stack" role="region" aria-label={t('resume.title')}>
      <h2>{t('resume.title')}</h2>
      {error ? <ErrorNotice error={error} /> : null}
      <ul className="list">
        {items.map((i) => {
          const waiting = photoQueue.unfinishedCount(i.id);
          return (
            <li key={i.id}>
              <div className="list-row">
                <span className="list-main">
                  <b><bdi>{i.title || i.id.slice(0, 8).toUpperCase()}</bdi></b>
                  <span className="muted"><bdi>{fmtDateTime(i.startedAt)}</bdi></span>
                  {offlineStarts.get(i.id) && <span className="muted">⏳ {t('resume.notSent')}</span>}
                  {waiting > 0 && <span className="muted">⏳ {t('resume.waiting', { n: waiting })}</span>}
                </span>
                <span className="list-side">
                  <button className="btn btn-primary" disabled={busy !== null} onClick={() => onOpen(i.id)}>{t('resume.continue')}</button>
                  <button className="btn btn-danger" disabled={busy !== null} onClick={() => void discard(i.id)}>{t('resume.discard')}</button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
