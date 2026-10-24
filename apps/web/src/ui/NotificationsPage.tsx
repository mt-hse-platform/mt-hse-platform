// The person's notifications. Tapping one marks it as read and opens what it is about.
import { useEffect, useState } from 'react';
import { endpoints } from '../platform.ts';
import { useT } from '../i18nReact.tsx';
import { EmptyState, ErrorNotice, LoadingBlock, fmtDateTime } from './common.tsx';
import { notificationView } from '../core/notifications.ts';
import type { NotificationDto } from '../core/notifications.ts';

export function NotificationsPage({ onOpen, onChanged }: { onOpen: (path: string) => void; onChanged: () => void }) {
  const t = useT();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  async function loadPage(cursor: string | undefined, replace: boolean) {
    setLoading(true);
    setError(null);
    try {
      const r = await endpoints.listNotifications({ unread: unreadOnly, cursor, limit: 25 });
      setItems((prev) => (replace ? r.items : [...prev, ...r.items]));
      setNext(r.nextCursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void loadPage(undefined, true); }, [unreadOnly]);

  async function open(n: NotificationDto, target: string) {
    if (n.readAt === null) {
      try {
        await endpoints.markRead({ ids: [n.id] });
        setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
        onChanged();
      } catch { /* opening the item matters more than the read mark */ }
    }
    onOpen(target);
  }

  async function markAll() {
    try {
      await endpoints.markRead({ all: true });
      setItems((prev) => prev.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
      onChanged();
    } catch (e) {
      setError(e);
    }
  }

  return (
    <section className="stack">
      <div className="row-between">
        <h1>{t('notif.title')}</h1>
        <button className="btn" onClick={() => void markAll()}>{t('notif.markAll')}</button>
      </div>
      <div className="choice-row" role="group">
        <button className={`choice ${!unreadOnly ? 'selected' : ''}`} onClick={() => setUnreadOnly(false)}>{t('work.all')}</button>
        <button className={`choice ${unreadOnly ? 'selected' : ''}`} onClick={() => setUnreadOnly(true)}>{t('notif.unreadOnly')}</button>
      </div>
      {error ? <ErrorNotice error={error} onRetry={() => void loadPage(undefined, true)} /> : null}
      {!loading && !error && items.length === 0 && <EmptyState title={t('notif.empty.title')} description={t('notif.empty.desc')} />}
      <ul className="list">
        {items.map((n) => {
          const v = notificationView(n, t('notif.someone'));
          return (
            <li key={n.id}>
              <button className={`list-row ${v.unread ? 'list-row-unread' : ''}`} onClick={() => void open(n, v.target)}>
                <span className="list-main">
                  <b><bdi>{t(v.messageKey, v.params)}</bdi></b>
                  <span className="muted"><bdi>{fmtDateTime(n.createdAt)}</bdi></span>
                </span>
                {v.unread && <span className="dot" aria-label="unread" />}
              </button>
            </li>
          );
        })}
      </ul>
      {loading && <LoadingBlock />}
      {next && !loading && <button className="btn" onClick={() => void loadPage(next, false)}>{t('inspections.loadMore')}</button>}
    </section>
  );
}
