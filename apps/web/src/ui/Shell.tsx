import { useState } from 'react';
import type { ReactNode } from 'react';
import { useT } from '../i18nReact.tsx';
import { Icon } from './Icon.tsx';
import { mobileNav, visibleNav, visibleQuickActions } from '../core/navigation.ts';
import { isActivePath } from '../core/router.ts';
import { badgeText } from '../core/notifications.ts';
import type { NavItem } from '../core/navigation.ts';
import type { Session } from '../core/session.ts';

export function Shell({
  session, offline, current, unread, onNavigate, children,
}: { session: Session; offline: boolean; current: string; unread: number; onNavigate: (path: string) => void; children: ReactNode }) {
  const t = useT();
  const [sheet, setSheet] = useState<'quick' | 'more' | null>(null);
  const items = visibleNav(session.grants);
  const quick = visibleQuickActions(session.grants);
  const mobile = mobileNav(items);

  const link = (i: NavItem, cls: string) => (
    <button key={i.id} className={`${cls} ${isActivePath(current, i.path) ? 'active' : ''}`} aria-current={isActivePath(current, i.path) ? 'page' : undefined}
      onClick={() => { setSheet(null); onNavigate(i.path); }}>
      <Icon name={i.id} />
      <span>{t(i.labelKey)}</span>
    </button>
  );

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Main">
        <div className="brand">{t('app.name')}</div>
        <nav>{items.map((i) => link(i, 'nav-link'))}</nav>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <span className={`chip ${offline ? 'chip-warning' : 'chip-success'}`}>
            {offline ? '⚠ ' + t('conn.offline_session') : '✓ ' + t('conn.online')}
          </span>
          <button className="bell" aria-label={t('notif.title') + (unread > 0 ? ` (${unread})` : '')} onClick={() => onNavigate('/notifications')}>
            <Icon name="bell" />
            {unread > 0 && <span className="bell-badge" aria-hidden="true">{badgeText(unread)}</span>}
          </button>
        </header>
        <main className="content">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="Main">
        {mobile.primary.map((i) => link(i, 'bn-link'))}
        {mobile.more.length > 0 && (
          <button className="bn-link" onClick={() => setSheet('more')}><Icon name="more" /><span>{t('nav.more')}</span></button>
        )}
      </nav>

      {quick.length > 0 && (
        <button className="fab" aria-label={t('quick.title')} onClick={() => setSheet('quick')}><Icon name="plus" size={26} /></button>
      )}

      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3>{sheet === 'quick' ? t('quick.title') : t('nav.more')}</h3>
            {sheet === 'quick'
              ? quick.map((a) => (
                  <button key={a.id} className="sheet-item" onClick={() => { setSheet(null); onNavigate(a.path); }}>{t(a.labelKey)}</button>
                ))
              : mobile.more.map((i) => link(i, 'sheet-item'))}
          </div>
        </div>
      )}
    </div>
  );
}
